import { StagehandPage } from "../StagehandPage";
import { AgentProvider } from "../agent/AgentProvider";
import { StagehandAgent } from "../agent/StagehandAgent";
import { AgentClient } from "../agent/AgentClient";
import { LogLine } from "../../types/log";
import { Page } from "playwright";
import {
  AgentExecuteOptions,
  AgentAction,
  AgentResult,
  AgentHandlerOptions,
  ActionExecutionResult,
} from "@/types/agent";
import * as fs from "fs";
import * as path from "path";
// The css-selector-generator library is loaded dynamically in the browser context

// Create a type declaration for the extended Window interface
declare global {
  interface Window {
    __stagehandCursorX?: number;
    __stagehandCursorY?: number;
    __updateCursorPosition?: (x: number, y: number) => void;
    __animateClick?: (x: number, y: number) => void;
  }
}

// Define an interface for recorded actions
interface RecordedAction {
  action: string;
  timestamp: string;
  success: boolean;
  selector?: string | null;
  details: {
    button?: string;
    x?: number;
    y?: number;
    text?: string;
    keys?: string[];
    deltaX?: number;
    deltaY?: number;
    duration?: number;
    url?: string;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    path?: { x: number; y: number }[];
    targetSelector?: string | null;
  };
}

// Define a proper type for draggable path points
interface PathPoint {
  x: number;
  y: number;
}

export class StagehandAgentHandler {
  private stagehandPage: StagehandPage;
  private agent: StagehandAgent;
  private provider: AgentProvider;
  private logger: (message: LogLine) => void;
  private agentClient: AgentClient;
  private options: AgentHandlerOptions;
  // New properties for action recording
  private recordedActions: RecordedAction[] = [];
  private sessionId: string;
  private fs: typeof fs;
  private path: typeof path;

  constructor(
    stagehandPage: StagehandPage,
    logger: (message: LogLine) => void,
    options: AgentHandlerOptions,
  ) {
    this.stagehandPage = stagehandPage;
    this.logger = logger;
    this.options = options;

    // Initialize the provider
    this.provider = new AgentProvider(logger);

    // Create client first
    const client = this.provider.getClient(
      options.modelName,
      options.clientOptions || {},
      options.userProvidedInstructions,
    );

    // Store the client
    this.agentClient = client;

    // Set up common functionality for any client type
    this.setupAgentClient();

    // Create agent with the client
    this.agent = new StagehandAgent(client, logger);

    // Initialize session ID with timestamp
    this.sessionId = `session_${Date.now()}`;

    // Initialize fs and path modules
    this.fs = fs;
    this.path = path;

    // Create the repeatables directory if it doesn't exist
    this.ensureRepeatablesDirExists();
  }

  private setupAgentClient(): void {
    // Set up screenshot provider for any client type
    this.agentClient.setScreenshotProvider(async () => {
      const screenshot = await this.stagehandPage.page.screenshot({
        fullPage: false,
      });
      // Convert to base64
      return screenshot.toString("base64");
    });

    // Set up action handler for any client type
    this.agentClient.setActionHandler(async (action) => {
      // Default delay between actions (1 second if not specified)
      const defaultDelay = 1000;
      // Use specified delay or default
      const waitBetweenActions =
        (this.options.clientOptions?.waitBetweenActions as number) ||
        defaultDelay;

      try {
        // Try to inject cursor before each action
        try {
          await this.injectCursor();
        } catch {
          // Ignore cursor injection failures
        }

        // Add a small delay before the action for better visibility
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Execute the action
        await this.executeAction(action);

        // Add a delay after the action for better visibility
        await new Promise((resolve) => setTimeout(resolve, waitBetweenActions));

        // After executing an action, take a screenshot
        try {
          await this.captureAndSendScreenshot();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger({
            category: "agent",
            message: `Warning: Failed to take screenshot after action: ${errorMessage}. Continuing execution.`,
            level: 1,
          });
          // Continue execution even if screenshot fails
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger({
          category: "agent",
          message: `Error executing action ${action.type}: ${errorMessage}`,
          level: 0,
        });
        throw error; // Re-throw the error to be handled by the caller
      }
    });

    // Update viewport and URL for any client type
    this.updateClientViewport();
    this.updateClientUrl();
  }

  /**
   * Execute a task with the agent
   */
  async execute(
    optionsOrInstruction: AgentExecuteOptions | string,
  ): Promise<AgentResult> {
    const options =
      typeof optionsOrInstruction === "string"
        ? { instruction: optionsOrInstruction }
        : optionsOrInstruction;

    //Redirect to Google if the URL is empty or about:blank
    const currentUrl = this.stagehandPage.page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      this.logger({
        category: "agent",
        message: `Page URL is empty or about:blank. Redirecting to www.google.com...`,
        level: 0,
      });
      await this.stagehandPage.page.goto("https://www.google.com");
    }

    this.logger({
      category: "agent",
      message: `Executing agent task: ${options.instruction}`,
      level: 1,
    });

    // Inject cursor for visual feedback
    try {
      await this.injectCursor();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger({
        category: "agent",
        message: `Warning: Failed to inject cursor: ${errorMessage}. Continuing with execution.`,
        level: 1,
      });
      // Continue execution even if cursor injection fails
    }

    // Take initial screenshot if needed
    if (options.autoScreenshot !== false) {
      try {
        await this.captureAndSendScreenshot();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger({
          category: "agent",
          message: `Warning: Failed to take initial screenshot: ${errorMessage}. Continuing with execution.`,
          level: 1,
        });
        // Continue execution even if screenshot fails
      }
    }

    // Reset recorded actions for a new execution
    this.recordedActions = [];
    // Generate a new session ID
    this.sessionId = `session_${Date.now()}`;

    // Execute the task
    const result = await this.agent.execute(optionsOrInstruction);

    // The actions are now executed during the agent's execution flow
    // We don't need to execute them again here

    // Save complete session of recorded actions
    await this.saveRecordedActions();

    return result;
  }

  /**
   * Execute a single action on the page
   */
  private async executeAction(
    action: AgentAction,
  ): Promise<ActionExecutionResult> {
    let result: ActionExecutionResult = { success: false };
    let targetElement: string | null = null;
    let selector: string | null = null;
    console.log("executing action", action);

    // Generate screenshot directory path with timestamp
    const screenshot_dir_path = `screenshots/${Date.now()}`;

    const screenshotsDir = path.resolve(screenshot_dir_path);
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const before_screenshot_path = path.join(screenshotsDir, `before.png`);
    const after_screenshot_path = path.join(screenshotsDir, `after.png`);

    // Take a screenshot before the action
    await this.stagehandPage.page.screenshot({
      path: before_screenshot_path,
    });
    console.log("before_screenshot_path", before_screenshot_path);
    try {
      switch (action.type) {
        case "click": {
          const { x, y, button = "left" } = action;

          // Get the element at this position BEFORE clicking
          // This ensures we capture the exact element that will be clicked
          selector = await this.generateSelector(x as number, y as number);
          this.logger({
            category: "agent",
            message: `Clicked element selector: ${selector}`,
            level: 1,
          });
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 300));
          // Perform the actual click
          await this.stagehandPage.page.mouse.click(x as number, y as number, {
            button: button as "left" | "right",
          });
          const newOpenedTab = await Promise.race([
            new Promise<Page | null>((resolve) => {
              this.stagehandPage.context.once("page", (page) => resolve(page));
              setTimeout(() => resolve(null), 1500);
            }),
          ]);
          if (newOpenedTab) {
            this.logger({
              category: "action",
              message: `New page detected (new tab) with URL. Opening on current page...`,
              level: 1,
              auxiliary: {
                url: {
                  value: newOpenedTab.url(),
                  type: "string",
                },
              },
            });
            await newOpenedTab.close();
            await this.stagehandPage.page.goto(newOpenedTab.url());
            await this.stagehandPage.page.waitForURL(newOpenedTab.url());
          }
          result = { success: true };
          break;
        }

        case "double_click": {
          const { x, y } = action;

          // Get the element at this position BEFORE clicking
          selector = await this.generateSelector(x as number, y as number);
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Animate the second click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Perform the actual double click
          await this.stagehandPage.page.mouse.dblclick(
            x as number,
            y as number,
          );
          result = { success: true };
          break;
        }

        // Handle the case for "doubleClick" as well for backward compatibility
        case "doubleClick": {
          const { x, y } = action;

          // Get the element at this position BEFORE clicking
          selector = await this.generateSelector(x as number, y as number);
          targetElement = await this.stagehandPage.page.evaluate(
            (coords) => {
              const elem = document.elementFromPoint(coords.x, coords.y);
              if (!elem) return null;

              // Capture key attributes for selector generation
              const id = elem.id ? `#${elem.id}` : null;
              const tagName = elem.tagName.toLowerCase();
              const textContent = elem.textContent?.trim();
              const className = elem.className?.toString().trim();

              return JSON.stringify({
                id,
                tagName,
                textContent,
                className,
                outerHTML: elem.outerHTML.substring(0, 500), // Limit length
              });
            },
            { x: Number(x), y: Number(y) },
          );

          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          // Animate the click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Animate the second click
          await this.animateClick(x as number, y as number);
          // Small delay to see the animation
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Perform the actual double click
          await this.stagehandPage.page.mouse.dblclick(
            x as number,
            y as number,
          );
          result = { success: true };
          break;
        }

        case "type": {
          const { text } = action;
          await this.stagehandPage.page.keyboard.type(text as string);
          result = { success: true };
          break;
        }

        case "keypress": {
          const { keys } = action;
          if (Array.isArray(keys)) {
            // Check if CTRL or CMD is present in the keys
            const hasModifier = keys.some(
              (key) =>
                key.includes("CTRL") ||
                key.includes("CMD") ||
                key.includes("COMMAND"),
            );

            if (hasModifier) {
              // Handle key combination - press all keys simultaneously
              // Convert all keys first
              const playwrightKeys = keys.map((key) => {
                if (key.includes("CTRL")) return "Meta";
                if (key.includes("CMD") || key.includes("COMMAND"))
                  return "Meta";
                return this.convertKeyName(key);
              });

              // Press all keys down in sequence
              for (const key of playwrightKeys) {
                await this.stagehandPage.page.keyboard.down(key);
              }

              // Small delay to ensure the combination is registered
              await new Promise((resolve) => setTimeout(resolve, 100));

              // Release all keys in reverse order
              for (const key of playwrightKeys.reverse()) {
                await this.stagehandPage.page.keyboard.up(key);
              }
            } else {
              // Handle individual keys as before
              for (const key of keys) {
                // Handle special keys
                if (key.includes("ENTER")) {
                  await this.stagehandPage.page.keyboard.press("Enter");
                } else if (key.includes("SPACE")) {
                  await this.stagehandPage.page.keyboard.press(" ");
                } else if (key.includes("TAB")) {
                  await this.stagehandPage.page.keyboard.press("Tab");
                } else if (key.includes("ESCAPE") || key.includes("ESC")) {
                  await this.stagehandPage.page.keyboard.press("Escape");
                } else if (key.includes("BACKSPACE")) {
                  await this.stagehandPage.page.keyboard.press("Backspace");
                } else if (key.includes("DELETE")) {
                  await this.stagehandPage.page.keyboard.press("Delete");
                } else if (key.includes("ARROW_UP")) {
                  await this.stagehandPage.page.keyboard.press("ArrowUp");
                } else if (key.includes("ARROW_DOWN")) {
                  await this.stagehandPage.page.keyboard.press("ArrowDown");
                } else if (key.includes("ARROW_LEFT")) {
                  await this.stagehandPage.page.keyboard.press("ArrowLeft");
                } else if (key.includes("ARROW_RIGHT")) {
                  await this.stagehandPage.page.keyboard.press("ArrowRight");
                } else {
                  // For other keys, use the existing conversion
                  const playwrightKey = this.convertKeyName(key);
                  await this.stagehandPage.page.keyboard.press(playwrightKey);
                }
              }
            }
          }
          result = { success: true };
          break;
        }

        case "scroll": {
          const { scroll_x = 0, scroll_y = 0 } = action;

          try {
            // Get the current cursor position
            const cursorPosition = await this.stagehandPage.page.evaluate(
              () => {
                return {
                  x: window.__stagehandCursorX || 0,
                  y: window.__stagehandCursorY || 0,
                };
              },
            );

            // Scroll the element at the cursor position if it's scrollable, otherwise scroll the window
            await this.stagehandPage.page.evaluate(
              ({ scrollX, scrollY, cursorX, cursorY }) => {
                // Find the element at the cursor position
                const element = document.elementFromPoint(cursorX, cursorY);

                if (element) {
                  // Check if this element or any of its parents is scrollable
                  let scrollableElement: Element | null = null;
                  let currentElement: Element | null = element;

                  // Function to check if an element is scrollable
                  const isScrollable = (el: Element): boolean => {
                    const style = window.getComputedStyle(el);
                    const overflowX = style.getPropertyValue("overflow-x");
                    const overflowY = style.getPropertyValue("overflow-y");

                    // Check if element has scrollable content
                    const hasScrollableContent =
                      el.scrollHeight > el.clientHeight ||
                      el.scrollWidth > el.clientWidth;

                    // Check if element has scrollable overflow style
                    const hasScrollableStyle =
                      ["auto", "scroll"].includes(overflowY) ||
                      ["auto", "scroll"].includes(overflowX);

                    return hasScrollableStyle && hasScrollableContent;
                  };

                  // Walk up the DOM tree looking for scrollable elements
                  while (currentElement && currentElement !== document.body) {
                    if (isScrollable(currentElement)) {
                      scrollableElement = currentElement;
                      break;
                    }
                    if (currentElement.parentElement) {
                      currentElement = currentElement.parentElement;
                    } else {
                      break;
                    }
                  }

                  // If found a scrollable element, scroll it
                  if (scrollableElement) {
                    scrollableElement.scrollBy(scrollX, scrollY);
                    return; // Exit early
                  }
                }

                // Fall back to window scrolling if no scrollable element was found
                window.scrollBy(scrollX, scrollY);
              },
              {
                scrollX: scroll_x as number,
                scrollY: scroll_y as number,
                cursorX: cursorPosition.x,
                cursorY: cursorPosition.y,
              },
            );

            result = { success: true };
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            this.logger({
              category: "agent",
              message: `Error executing scroll action: ${errorMessage}`,
              level: 0,
            });
            result = {
              success: false,
              error: errorMessage,
            };
          }
          break;
        }

        case "drag": {
          const dragPath = action.path as PathPoint[] | undefined;
          if (Array.isArray(dragPath) && dragPath.length >= 2) {
            const start = dragPath[0];
            //const end = dragPath[dragPath.length - 1];

            // // Try selector-based drag-and-drop first (fires HTML5 drag events)
            // try {
            //   const sourceSelector = await this.generateSelector(start.x, start.y);
            //   const targetSelector = await this.generateSelector(end.x, end.y);

            //   const toPlaywrightSelector = (sel: string | null): string | null => {
            //     if (!sel) return null;
            //     return sel.startsWith("//") ? `xpath=${sel}` : sel;
            //   };

            //   const pwSource = toPlaywrightSelector(sourceSelector);
            //   const pwTarget = toPlaywrightSelector(targetSelector);

            //   if (pwSource && pwTarget) {
            //     await this.stagehandPage.page.dragAndDrop(pwSource, pwTarget, {
            //       force: true,
            //     });
            //     result = { success: true };
            //     break;
            //   }
            // } catch {
            //   // Fallback to mouse path dragging
            // }

            // // Fallback: simulate drag via mouse moves with small steps and delays
            await this.updateCursorPosition(start.x, start.y);
            await this.stagehandPage.page.mouse.move(start.x, start.y);
            await this.stagehandPage.page.mouse.down({ button: "left" });

            for (let i = 1; i < dragPath.length; i++) {
              const point = dragPath[i];
              await this.updateCursorPosition(point.x, point.y);
              await this.stagehandPage.page.mouse.move(point.x, point.y, { steps: 5 });
              // Small delay to ensure intermediate events fire (dragover, etc.)
              await new Promise((resolve) => setTimeout(resolve, 16));
            }

            await this.stagehandPage.page.mouse.up({ button: "left" });
          }
          result = { success: true };
          break;
        }

        case "move": {
          const { x, y } = action;
          // Update cursor position first
          await this.updateCursorPosition(x as number, y as number);
          await this.stagehandPage.page.mouse.move(x as number, y as number);
          result = { success: true };
          break;
        }

        case "wait": {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          result = { success: true };
          break;
        }

        case "screenshot": {
          // Screenshot is handled automatically by the agent client
          // after each action, so we don't need to do anything here
          result = { success: true };
          break;
        }

        case "function": {
          const { name, arguments: args = {} } = action;

          if (
            name === "goto" &&
            typeof args === "object" &&
            args !== null &&
            "url" in args
          ) {
            await this.stagehandPage.page.goto(args.url as string);
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "back") {
            await this.stagehandPage.page.goBack();
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "forward") {
            await this.stagehandPage.page.goForward();
            this.updateClientUrl();
            result = { success: true };
          } else if (name === "reload") {
            await this.stagehandPage.page.reload();
            this.updateClientUrl();
            result = { success: true };
          } else {
            result = {
              success: false,
              error: `Unsupported function: ${name}`,
            };
          }
          break;
        }

        case "key": {
          // Handle the 'key' action type from Anthropic
          const { text } = action;
          if (text === "Return" || text === "Enter") {
            await this.stagehandPage.page.keyboard.press("Enter");
          } else if (text === "Tab") {
            await this.stagehandPage.page.keyboard.press("Tab");
          } else if (text === "Escape" || text === "Esc") {
            await this.stagehandPage.page.keyboard.press("Escape");
          } else if (text === "Backspace") {
            await this.stagehandPage.page.keyboard.press("Backspace");
          } else {
            // For other keys, try to press directly
            await this.stagehandPage.page.keyboard.press(text as string);
          }
          result = { success: true };
          break;
        }

        default:
          result = {
            success: false,
            error: `Unsupported action type: ${action.type}`,
          };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger({
        category: "agent",
        message: `Error executing action ${action.type}: ${errorMessage}`,
        level: 0,
      });

      result = {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Take a screenshot after the action
      await this.stagehandPage.page.screenshot({
        path: after_screenshot_path,
      });
      console.log("after_screenshot_path", after_screenshot_path);
    }

    // Record the action and its result
    console.log("targetElement", targetElement);
    console.log("action", action);
    console.log("selector", selector);
    await this.recordAction(action, result, targetElement, selector);

    return result;
  }

  private updateClientViewport(): void {
    const viewportSize = this.stagehandPage.page.viewportSize();
    if (viewportSize) {
      this.agentClient.setViewport(viewportSize.width, viewportSize.height);
    }
  }

  private updateClientUrl(): void {
    const url = this.stagehandPage.page.url();
    this.agentClient.setCurrentUrl(url);
  }

  getAgent(): StagehandAgent {
    return this.agent;
  }

  getClient(): AgentClient {
    return this.agentClient;
  }

  async captureAndSendScreenshot(): Promise<unknown> {
    this.logger({
      category: "agent",
      message: "Taking screenshot and sending to agent",
      level: 1,
    });

    try {
      // Take screenshot of the current page
      const screenshot = await this.stagehandPage.page.screenshot({
        type: "png",
        fullPage: false,
      });

      // Convert to base64
      const base64Image = screenshot.toString("base64");

      // Just use the captureScreenshot method on the agent client
      return await this.agentClient.captureScreenshot({
        base64Image,
        currentUrl: this.stagehandPage.page.url(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger({
        category: "agent",
        message: `Error capturing screenshot: ${errorMessage}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Inject a cursor element into the page for visual feedback
   */
  private async injectCursor(): Promise<void> {
    try {
      // Define constants for cursor and highlight element IDs
      const CURSOR_ID = "stagehand-cursor";
      const HIGHLIGHT_ID = "stagehand-highlight";

      // Check if cursor already exists
      const cursorExists = await this.stagehandPage.page.evaluate(
        (id: string) => {
          return !!document.getElementById(id);
        },
        CURSOR_ID,
      );

      if (cursorExists) {
        return;
      }

      // Inject cursor and highlight elements
      await this.stagehandPage.page.evaluate(`
        (function(cursorId, highlightId) {
          // Function to detect if background is dark
          function isDarkBackground(x, y) {
            const element = document.elementFromPoint(x, y);
            if (!element) return false;
            
            const style = window.getComputedStyle(element);
            const backgroundColor = style.backgroundColor;
            
            // Parse RGB values
            const rgb = backgroundColor.match(/\\d+/g);
            if (!rgb || rgb.length < 3) return false;
            
            // Calculate relative luminance
            const r = parseInt(rgb[0]) / 255;
            const g = parseInt(rgb[1]) / 255;
            const b = parseInt(rgb[2]) / 255;
            
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            return luminance < 0.5;
          }

          // Create cursor element
          const cursor = document.createElement('div');
          cursor.id = cursorId;
          
          // Function to update cursor SVG based on background
          function updateCursorSVG(x, y) {
            const isDark = isDarkBackground(x, y);
            const fillColor = isDark ? '#FFFFFF' : '#000000';
            const strokeColor = isDark ? '#000000' : 'none';
            
            cursor.innerHTML = \`
            <svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 28 28" width="28" height="28">
              <polygon fill="\${fillColor}" stroke="\${strokeColor}" stroke-width="1" points="9.2,7.3 9.2,18.5 12.2,15.6 12.6,15.5 17.4,15.5"/>
              <rect x="12.5" y="13.6" transform="matrix(0.9221 -0.3871 0.3871 0.9221 -5.7605 6.5909)" width="2" height="8" fill="\${fillColor}" stroke="\${strokeColor}" stroke-width="1"/>
            </svg>
            \`;
          }
          
          // Initial cursor SVG
          updateCursorSVG(0, 0);
          
          // Style the cursor
          cursor.style.position = 'absolute';
          cursor.style.top = '0';
          cursor.style.left = '0';
          cursor.style.width = '28px';
          cursor.style.height = '28px';
          cursor.style.pointerEvents = 'none';
          cursor.style.zIndex = '9999999';
          cursor.style.transform = 'translate(-4px, -4px)'; // Adjust to align the pointer tip
          
          // Create highlight element for click animation
          const highlight = document.createElement('div');
          highlight.id = highlightId;
          highlight.style.position = 'absolute';
          highlight.style.width = '20px';
          highlight.style.height = '20px';
          highlight.style.borderRadius = '50%';
          highlight.style.backgroundColor = 'rgba(66, 134, 244, 0)';
          highlight.style.transform = 'translate(-50%, -50%) scale(0)';
          highlight.style.pointerEvents = 'none';
          highlight.style.zIndex = '9999998';
          highlight.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
          highlight.style.opacity = '0';
          
          // Add elements to the document
          document.body.appendChild(cursor);
          document.body.appendChild(highlight);
          
          // Initialize cursor position variables
          window.__stagehandCursorX = 0;
          window.__stagehandCursorY = 0;
          
          // Add a function to update cursor position
          window.__updateCursorPosition = function(x, y) {
            if (cursor) {
              cursor.style.transform = \`translate(\${x - 4}px, \${y - 4}px)\`;
              
              // Update cursor SVG based on background color
              updateCursorSVG(x, y);
              
              // Store the cursor position for later use by other functions
              window.__stagehandCursorX = x;
              window.__stagehandCursorY = y;
            }
          };
          
          // Add a function to animate click
          window.__animateClick = function(x, y) {
            if (highlight) {
              highlight.style.left = \`\${x}px\`;
              highlight.style.top = \`\${y}px\`;
              highlight.style.transform = 'translate(-50%, -50%) scale(1)';
              highlight.style.opacity = '1';
              
              setTimeout(() => {
                highlight.style.transform = 'translate(-50%, -50%) scale(0)';
                highlight.style.opacity = '0';
              }, 300);
            }
          };
        })('${CURSOR_ID}', '${HIGHLIGHT_ID}');
      `);

      this.logger({
        category: "agent",
        message: "Cursor injected for visual feedback",
        level: 1,
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Failed to inject cursor: ${error}`,
        level: 0,
      });
    }
  }

  /**
   * Update the cursor position on the page
   */
  private async updateCursorPosition(x: number, y: number): Promise<void> {
    try {
      await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((window as any).__updateCursorPosition) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__updateCursorPosition(x, y);
          }
        },
        { x, y },
      );
    } catch {
      // Silently fail if cursor update fails
      // This is not critical functionality
    }
  }

  /**
   * Animate a click at the given position
   */
  private async animateClick(x: number, y: number): Promise<void> {
    try {
      await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((window as any).__animateClick) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__animateClick(x, y);
          }
        },
        { x, y },
      );
    } catch {
      // Silently fail if animation fails
      // This is not critical functionality
    }
  }

  private convertKeyName(key: string): string {
    // Map of CUA key names to Playwright key names
    const keyMap: Record<string, string> = {
      ENTER: "Enter",
      ESCAPE: "Escape",
      BACKSPACE: "Backspace",
      TAB: "Tab",
      SPACE: " ",
      ARROWUP: "ArrowUp",
      ARROWDOWN: "ArrowDown",
      ARROWLEFT: "ArrowLeft",
      ARROWRIGHT: "ArrowRight",
      UP: "ArrowUp",
      DOWN: "ArrowDown",
      LEFT: "ArrowLeft",
      RIGHT: "ArrowRight",
      SHIFT: process.platform === "darwin" ? "Meta" : "Control", // Use Meta on macOS
      CONTROL: process.platform === "darwin" ? "Meta" : "Control", // Use Meta on macOS
      ALT: "Alt",
      META: "Meta",
      COMMAND: "Meta",
      CMD: "Meta",
      DELETE: "Delete",
      HOME: "Home",
      END: "End",
      PAGEUP: "PageUp",
      PAGEDOWN: "PageDown",
    };

    // Convert to uppercase for case-insensitive matching
    const upperKey = key.toUpperCase();

    // Return the mapped key or the original key if not found
    return keyMap[upperKey] || key;
  }

  // Ensure the repeatables directory exists
  private ensureRepeatablesDirExists(): void {
    try {
      const dirPath = this.path.join(process.cwd(), "repeatables");
      if (!this.fs.existsSync(dirPath)) {
        this.fs.mkdirSync(dirPath, { recursive: true });
        this.logger({
          category: "agent",
          message: `Created repeatables directory at ${dirPath}`,
          level: 1,
        });
      }
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error creating repeatables directory: ${error}`,
        level: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  Enhanced generateSelector with ancestor-first approach and robust heuristics
  // ---------------------------------------------------------------------------
  private async generateSelector(x: number, y: number): Promise<string | null> {
    try {
      return await this.stagehandPage.page.evaluate(
        ({ x, y }) => {
          // Performance timeout to prevent infinite loops on large DOMs
          const startTime = Date.now();
          const TIMEOUT_MS = 50;

          const isTimedOut = () => Date.now() - startTime > TIMEOUT_MS;

          /*──────────────────────── Enhanced helpers ────────────────────────*/
          const isSelectorUnique = (sel: string, targetElement: Element) => {
            if (isTimedOut()) return false;
            try {
              const els = document.querySelectorAll(sel);
              return els.length === 1 && els[0] === targetElement;
            } catch {
              return false;
            }
          };

          // Custom CSS escape function that handles numeric starts properly
          const cssEscape = (str: string): string => {
            if (!str) return str;

            // Use CSS.escape but fix the numeric start issue
            let escaped = CSS.escape(str);

            // Fix the space issue after hex escape sequences for numeric starts
            // CSS.escape turns "1-email" into "\31 -email" but we want "\31-email"
            escaped = escaped.replace(/\\([0-9a-f]+)\s+(-)/gi, "\\$1$2");

            return escaped;
          };

          // Enhanced dynamic ID detection with UUID/GUID patterns
          const isLikelyDynamicId = (id: string) =>
            id.includes(":") ||
            /^radix-/.test(id) ||
            /^[A-Za-z]+-[0-9a-f]{6,}$/.test(id) ||
            // UUID/GUID patterns
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              id,
            ) ||
            // Base-62 IDs and other hash patterns
            /^[A-Za-z0-9]{12,}$/.test(id) ||
            // React/Vue component IDs
            /^(react|vue|ng)-[A-Za-z0-9]+/.test(id);

          // Enhanced dynamic class detection
          const isLikelyDynamicClass = (cls: string) =>
            cls.includes(":") || // Tailwind modifiers: hover:, md:, etc.
            (cls.length > 15 && /^[a-z0-9]+$/.test(cls)) || // Very long lowercase+digit only
            /\d{2,}/.test(cls) || // Contains 2+ consecutive digits
            /^css-[a-f0-9]{6,}$/i.test(cls) || // CSS-in-JS hashes
            /^[a-z]+-[A-Za-z0-9]{6,}$/.test(cls) || // Framework generated
            /^(ng|vue|jsx|astro|styled)-/.test(cls) || // Framework prefixes
            (cls.startsWith("_") && cls.length > 8); // Private/generated classes

          const getAccessibleName = (element: Element): string | null => {
            const ariaLabel = element.getAttribute("aria-label");
            if (ariaLabel) return ariaLabel;

            const textContent = element.textContent?.trim();
            if (textContent && textContent.length < 50) return textContent;

            return null;
          };

          const getElementRole = (element: Element): string => {
            return (
              element.getAttribute("role") || element.tagName.toLowerCase()
            );
          };

          // Find the nearest stable ancestor with good selector attributes
          const findStableAncestor = (element: Element): Element | null => {
            let current: Element | null = element;

            while (current && current !== document.body && !isTimedOut()) {
              // Check for data-test attributes (highest priority)
              const testAttrs = [
                "data-testid",
                "data-test",
                "data-cy",
                "data-automation-id",
                "data-qa",
                "data-test-id",
              ];

              for (const attr of testAttrs) {
                if (current.hasAttribute(attr)) return current;
              }

              // Check for stable IDs
              if (current.id && !isLikelyDynamicId(current.id)) {
                return current;
              }

              // Check for role with accessible name combination
              const role = current.getAttribute("role");
              const accessibleName = getAccessibleName(current);
              if (role && accessibleName) {
                return current;
              }

              // Check for semantic landmarks
              const semanticTags = [
                "main",
                "nav",
                "header",
                "footer",
                "section",
                "article",
                "aside",
              ];
              if (semanticTags.includes(current.tagName.toLowerCase())) {
                return current;
              }

              current = current.parentElement;
            }

            return null;
          };

          // Build selector for a specific element (used for both ancestor and target)
          const buildElementSelector = (
            element: Element,
            options: { forbidAncestor?: boolean } = {},
          ): string | null => {
            if (isTimedOut()) return null;

            /*──────────────────────── 1) Test attributes (highest priority) ─────────────────*/
            const testAttrs = [
              "data-testid",
              "data-test",
              "data-cy",
              "data-automation-id",
              "data-qa",
              "data-test-id",
            ];

            for (const attr of testAttrs) {
              const val = element.getAttribute(attr);
              if (val) {
                const sel = `[${attr}="${cssEscape(val)}"]`;
                if (isSelectorUnique(sel, element)) return sel;
              }
            }

            /*──────────────────────── 2) Stable ID ─────────────────*/
            if (element.id && !isLikelyDynamicId(element.id)) {
              const idSel = `#${cssEscape(element.id)}`;
              if (isSelectorUnique(idSel, element)) return idSel;
            }

            /*──────────────────────── 3) Role + Accessible Name ─────────────────*/
            const role = getElementRole(element);
            const accessibleName = getAccessibleName(element);
            if (accessibleName) {
              // Try role + aria-label combination
              const ariaLabel = element.getAttribute("aria-label");
              if (ariaLabel) {
                const sel = `[role="${role}"][aria-label="${cssEscape(ariaLabel)}"]`;
                if (isSelectorUnique(sel, element)) return sel;
              }

              // Try tag + text content for interactive elements
              if (
                ["button", "a", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
                  role,
                )
              ) {
                const sel = `${role}:has-text("${cssEscape(accessibleName)}")`;
                // Fallback to XPath if :has-text not supported
                try {
                  if (isSelectorUnique(sel, element)) return sel;
                } catch {
                  const xpath = `//${role}[contains(text(), "${accessibleName.replace(/"/g, '\\"')}")]`;
                  try {
                    const result = document.evaluate(
                      xpath,
                      document,
                      null,
                      XPathResult.FIRST_ORDERED_NODE_TYPE,
                      null,
                    );
                    if (result.singleNodeValue === element) return xpath;
                  } catch {
                    // Continue to next strategy
                  }
                }
              }
            }

            /*──────────────────────── 4) Form attributes ─────────────────*/
            const formAttrs = ["name", "placeholder", "for", "type"];
            for (const attr of formAttrs) {
              const val = element.getAttribute(attr);
              if (val) {
                const sel = `${element.tagName.toLowerCase()}[${attr}="${cssEscape(val)}"]`;
                if (isSelectorUnique(sel, element)) return sel;
              }
            }

            /*──────────────────────── 5) ARIA attributes ─────────────────*/
            const ariaAttrs = [
              "aria-label",
              "aria-labelledby",
              "aria-describedby",
              "aria-controls",
              "aria-expanded",
              "aria-selected",
            ];

            for (const attr of ariaAttrs) {
              const val = element.getAttribute(attr);
              if (val && !isLikelyDynamicId(val)) {
                const sel = `${element.tagName.toLowerCase()}[${attr}="${cssEscape(val)}"]`;
                if (isSelectorUnique(sel, element)) return sel;
              }
            }

            /*──────────────────────── 6) Stable classes ─────────────────*/
            if (element.className && typeof element.className === "string") {
              const classes = element.className.split(/\s+/).filter(Boolean);
              const stableClasses = classes.filter(
                (cls) => !isLikelyDynamicClass(cls),
              );

              if (stableClasses.length > 0) {
                const tag = element.tagName.toLowerCase();

                // Try combination of up to 2 stable classes
                for (let i = 0; i < Math.min(stableClasses.length, 2); i++) {
                  const classSelector = stableClasses.slice(0, i + 1);
                  const sel = `${tag}.${classSelector.map(cssEscape).join(".")}`;
                  if (isSelectorUnique(sel, element)) return sel;
                }
              }
            }

            /*──────────────────────── 7) Positional with nth-of-type ─────────────────*/
            if (element.parentElement && !options.forbidAncestor) {
              const siblings = Array.from(
                element.parentElement.children,
              ).filter((el) => el.tagName === element.tagName);

              if (siblings.length > 1) {
                const index = siblings.indexOf(element) + 1;
                const sel = `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
                if (isSelectorUnique(sel, element)) return sel;
              }
            }

            return null;
          };

          /*──────────────────────── Main algorithm ────────────────────────*/
          const element = document.elementFromPoint(x, y);
          if (!element) return null;

          // Strategy 1: Try to build a direct selector for the element
          const directSelector = buildElementSelector(element);
          if (directSelector) return directSelector;

          // Strategy 2: Ancestor-first approach
          const stableAncestor = findStableAncestor(element.parentElement);
          if (stableAncestor && !isTimedOut()) {
            const ancestorSelector = buildElementSelector(stableAncestor);
            if (ancestorSelector) {
              // Build a relative selector from ancestor to target
              const leafSelector = buildElementSelector(element, {
                forbidAncestor: true,
              });
              if (leafSelector) {
                const combinedSelector = `${ancestorSelector} ${leafSelector}`;
                if (isSelectorUnique(combinedSelector, element)) {
                  return combinedSelector;
                }
              }

              // Fallback: use positional selector from ancestor
              let current = element;
              const pathSegments: string[] = [];

              while (current && current !== stableAncestor && !isTimedOut()) {
                if (current.parentElement) {
                  const siblings = Array.from(
                    current.parentElement.children,
                  ).filter((el) => el.tagName === current.tagName);
                  const index = siblings.indexOf(current) + 1;
                  pathSegments.unshift(
                    `${current.tagName.toLowerCase()}:nth-of-type(${index})`,
                  );
                }
                current = current.parentElement;
              }

              if (pathSegments.length > 0) {
                const relativeSelector = `${ancestorSelector} ${pathSegments.join(" > ")}`;
                if (isSelectorUnique(relativeSelector, element)) {
                  return relativeSelector;
                }
              }
            }
          }

          // Strategy 3: CSS path with nth-of-type (improved fallback)
          if (!isTimedOut()) {
            try {
              const pathSegments: string[] = [];
              let current: Element | null = element;

              while (
                current &&
                current !== document.body &&
                pathSegments.length < 10
              ) {
                if (current.parentElement) {
                  const siblings = Array.from(
                    current.parentElement.children,
                  ).filter((el) => el.tagName === current.tagName);

                  if (siblings.length === 1) {
                    pathSegments.unshift(current.tagName.toLowerCase());
                  } else {
                    const index = siblings.indexOf(current) + 1;
                    pathSegments.unshift(
                      `${current.tagName.toLowerCase()}:nth-of-type(${index})`,
                    );
                  }

                  // Test if current path is unique
                  const testSelector = pathSegments.join(" > ");
                  if (isSelectorUnique(testSelector, element)) {
                    return testSelector;
                  }
                }
                current = current.parentElement;
              }
            } catch {
              // Continue to final fallback
            }
          }

          // Strategy 4: Final fallback with nth-child (guaranteed path)
          if (isTimedOut()) {
            return null; // Bail out if we've hit the timeout
          }

          try {
            const pathSegments: string[] = [];
            let current: Element | null = element;

            while (
              current &&
              current !== document.body &&
              pathSegments.length < 15
            ) {
              if (current.parentElement) {
                const index =
                  Array.from(current.parentElement.children).indexOf(current) +
                  1;
                pathSegments.unshift(
                  `${current.tagName.toLowerCase()}:nth-child(${index})`,
                );
              }
              current = current.parentElement;
            }

            if (pathSegments.length > 0) {
              return `body > ${pathSegments.join(" > ")}`;
            }
          } catch {
            // Final emergency fallback
            return element.tagName.toLowerCase();
          }

          return null;
        },
        { x, y },
      );
    } catch (err) {
      this.logger({
        category: "agent",
        message: `Error generating selector: ${err}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Get selector for the currently active element using enhanced robust logic
   */
  private async getActiveElementSelector(): Promise<string | null> {
    try {
      return await this.stagehandPage.page.evaluate(() => {
        const element = document.activeElement as Element;
        if (!element || element === document.body) return "body";

        // Performance timeout to prevent infinite loops
        const startTime = Date.now();
        const TIMEOUT_MS = 30; // Shorter timeout for active element
        const isTimedOut = () => Date.now() - startTime > TIMEOUT_MS;

        /*──────────────────────── Enhanced helpers ────────────────────────*/
        const isSelectorUnique = (sel: string, targetElement: Element) => {
          if (isTimedOut()) return false;
          try {
            const els = document.querySelectorAll(sel);
            return els.length === 1 && els[0] === targetElement;
          } catch {
            return false;
          }
        };

        // Custom CSS escape function that handles numeric starts properly
        const cssEscape = (str: string): string => {
          if (!str) return str;

          // Use CSS.escape but fix the numeric start issue
          let escaped = CSS.escape(str);

          // Fix the space issue after hex escape sequences for numeric starts
          // CSS.escape turns "1-email" into "\31 -email" but we want "\31-email"
          escaped = escaped.replace(/\\([0-9a-f]+)\s+(-)/gi, "\\$1$2");

          return escaped;
        };

        // Enhanced dynamic ID detection
        const isLikelyDynamicId = (id: string) =>
          id.includes(":") ||
          /^radix-/.test(id) ||
          /^[A-Za-z]+-[0-9a-f]{6,}$/.test(id) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id,
          ) ||
          /^[A-Za-z0-9]{12,}$/.test(id) ||
          /^(react|vue|ng)-[A-Za-z0-9]+/.test(id);

        // Enhanced dynamic class detection
        const isLikelyDynamicClass = (cls: string) =>
          cls.includes(":") ||
          (cls.length > 15 && /^[a-z0-9]+$/.test(cls)) ||
          /\d{2,}/.test(cls) ||
          /^css-[a-f0-9]{6,}$/i.test(cls) ||
          /^[a-z]+-[A-Za-z0-9]{6,}$/.test(cls) ||
          /^(ng|vue|jsx|astro|styled)-/.test(cls) ||
          (cls.startsWith("_") && cls.length > 8);

        const getAccessibleName = (element: Element): string | null => {
          const ariaLabel = element.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel;

          const textContent = element.textContent?.trim();
          if (textContent && textContent.length < 50) return textContent;

          return null;
        };

        const getElementRole = (element: Element): string => {
          return element.getAttribute("role") || element.tagName.toLowerCase();
        };

        // Find the nearest stable ancestor
        const findStableAncestor = (element: Element): Element | null => {
          let current: Element | null = element.parentElement;

          while (current && current !== document.body && !isTimedOut()) {
            const testAttrs = [
              "data-testid",
              "data-test",
              "data-cy",
              "data-automation-id",
              "data-qa",
              "data-test-id",
            ];

            for (const attr of testAttrs) {
              if (current.hasAttribute(attr)) return current;
            }

            if (current.id && !isLikelyDynamicId(current.id)) {
              return current;
            }

            const role = current.getAttribute("role");
            const accessibleName = getAccessibleName(current);
            if (role && accessibleName) {
              return current;
            }

            const semanticTags = [
              "main",
              "nav",
              "header",
              "footer",
              "section",
              "article",
              "aside",
              "form",
            ];
            if (semanticTags.includes(current.tagName.toLowerCase())) {
              return current;
            }

            current = current.parentElement;
          }

          return null;
        };

        // Build enhanced selector for the active element
        const buildActiveElementSelector = (
          element: Element,
          options: { forbidAncestor?: boolean } = {},
        ): string | null => {
          if (isTimedOut()) return null;

          /*──────────────────────── 1) Test attributes (highest priority) ─────────────────*/
          const testAttrs = [
            "data-testid",
            "data-test",
            "data-cy",
            "data-automation-id",
            "data-qa",
            "data-test-id",
          ];

          for (const attr of testAttrs) {
            const val = element.getAttribute(attr);
            if (val) {
              const sel = `[${attr}="${cssEscape(val)}"]`;
              if (isSelectorUnique(sel, element)) return sel;
            }
          }

          /*──────────────────────── 2) Stable ID ─────────────────*/
          if (element.id && !isLikelyDynamicId(element.id)) {
            const idSel = `#${cssEscape(element.id)}`;
            if (isSelectorUnique(idSel, element)) return idSel;
          }

          /*──────────────────────── 3) Role + Accessible Name ─────────────────*/
          const role = getElementRole(element);
          const accessibleName = getAccessibleName(element);
          if (accessibleName) {
            const ariaLabel = element.getAttribute("aria-label");
            if (ariaLabel) {
              const sel = `[role="${role}"][aria-label="${cssEscape(ariaLabel)}"]`;
              if (isSelectorUnique(sel, element)) return sel;
            }

            // For form elements, prefer accessible name patterns
            if (["input", "select", "textarea", "button"].includes(role)) {
              const sel = `${role}[aria-label="${cssEscape(accessibleName)}"]`;
              if (isSelectorUnique(sel, element)) return sel;
            }
          }

          /*──────────────────────── 4) Form attributes (critical for active elements) ─────────────────*/
          const formAttrs = ["name", "placeholder", "for", "type", "value"];
          for (const attr of formAttrs) {
            const val = element.getAttribute(attr);
            if (val && (attr !== "value" || val.length < 20)) {
              // Avoid long values
              const sel = `${element.tagName.toLowerCase()}[${attr}="${cssEscape(val)}"]`;
              if (isSelectorUnique(sel, element)) return sel;
            }
          }

          /*──────────────────────── 5) ARIA attributes ─────────────────*/
          const ariaAttrs = [
            "aria-label",
            "aria-labelledby",
            "aria-describedby",
            "aria-controls",
            "aria-expanded",
            "aria-selected",
            "aria-required",
          ];

          for (const attr of ariaAttrs) {
            const val = element.getAttribute(attr);
            if (val && !isLikelyDynamicId(val)) {
              const sel = `${element.tagName.toLowerCase()}[${attr}="${cssEscape(val)}"]`;
              if (isSelectorUnique(sel, element)) return sel;
            }
          }

          /*──────────────────────── 6) Stable classes ─────────────────*/
          if (element.className && typeof element.className === "string") {
            const classes = element.className.split(/\s+/).filter(Boolean);
            const stableClasses = classes.filter(
              (cls) => !isLikelyDynamicClass(cls),
            );

            if (stableClasses.length > 0) {
              const tag = element.tagName.toLowerCase();

              // Try combination of up to 2 stable classes
              for (let i = 0; i < Math.min(stableClasses.length, 2); i++) {
                const classSelector = stableClasses.slice(0, i + 1);
                const sel = `${tag}.${classSelector.map(cssEscape).join(".")}`;
                if (isSelectorUnique(sel, element)) return sel;
              }
            }
          }

          /*──────────────────────── 7) Positional with nth-of-type ─────────────────*/
          if (element.parentElement && !options.forbidAncestor) {
            const siblings = Array.from(element.parentElement.children).filter(
              (el) => el.tagName === element.tagName,
            );

            if (siblings.length > 1) {
              const index = siblings.indexOf(element) + 1;
              const sel = `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
              if (isSelectorUnique(sel, element)) return sel;
            }
          }

          return null;
        };

        /*──────────────────────── Main algorithm ────────────────────────*/

        // Strategy 1: Try to build a direct selector for the active element
        const directSelector = buildActiveElementSelector(element);
        if (directSelector) return directSelector;

        // Strategy 2: Ancestor-first approach
        const stableAncestor = findStableAncestor(element);
        if (stableAncestor && !isTimedOut()) {
          const ancestorSelector = buildActiveElementSelector(stableAncestor);
          if (ancestorSelector) {
            // Build a relative selector from ancestor to target
            const leafSelector = buildActiveElementSelector(element, {
              forbidAncestor: true,
            });
            if (leafSelector) {
              const combinedSelector = `${ancestorSelector} ${leafSelector}`;
              if (isSelectorUnique(combinedSelector, element)) {
                return combinedSelector;
              }
            }

            // Fallback: use positional selector from ancestor
            let current = element;
            const pathSegments: string[] = [];

            while (current && current !== stableAncestor && !isTimedOut()) {
              if (current.parentElement) {
                const siblings = Array.from(
                  current.parentElement.children,
                ).filter((el) => el.tagName === current.tagName);
                const index = siblings.indexOf(current) + 1;
                pathSegments.unshift(
                  `${current.tagName.toLowerCase()}:nth-of-type(${index})`,
                );
              }
              current = current.parentElement;
            }

            if (pathSegments.length > 0) {
              const relativeSelector = `${ancestorSelector} ${pathSegments.join(" > ")}`;
              if (isSelectorUnique(relativeSelector, element)) {
                return relativeSelector;
              }
            }
          }
        }

        // Strategy 3: Text content for interactive elements
        const textContent = element.textContent?.trim();
        if (textContent && textContent.length > 0 && textContent.length < 50) {
          const tag = element.tagName.toLowerCase();
          if (["button", "a", "label", "span"].includes(tag)) {
            try {
              const xpath = `//${tag}[contains(text(), "${textContent.slice(0, 20).replace(/"/g, '\\"')}")]`;
              const result = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
              );
              if (result.singleNodeValue === element) return xpath;
            } catch {
              // Continue to next strategy
            }
          }
        }

        // Strategy 4: CSS path with nth-of-type (fallback)
        if (!isTimedOut()) {
          try {
            const pathSegments: string[] = [];
            let current: Element | null = element;

            while (
              current &&
              current !== document.body &&
              pathSegments.length < 8
            ) {
              if (current.parentElement) {
                const siblings = Array.from(
                  current.parentElement.children,
                ).filter((el) => el.tagName === current.tagName);

                if (siblings.length === 1) {
                  pathSegments.unshift(current.tagName.toLowerCase());
                } else {
                  const index = siblings.indexOf(current) + 1;
                  pathSegments.unshift(
                    `${current.tagName.toLowerCase()}:nth-of-type(${index})`,
                  );
                }

                const testSelector = pathSegments.join(" > ");
                if (isSelectorUnique(testSelector, element)) {
                  return testSelector;
                }
              }
              current = current.parentElement;
            }
          } catch {
            // Continue to final fallback
          }
        }

        // Final fallback: just the tag name
        return element.tagName.toLowerCase();
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error getting active element selector: ${error}`,
        level: 0,
      });
      return null;
    }
  }

  /**
   * Record an action with necessary details
   */
  private async recordAction(
    action: AgentAction,
    result: ActionExecutionResult,
    capturedElement: string | null = null,
    selector: string | null = null,
  ): Promise<void> {
    this.logger({
      category: "agent",
      message: `Recording action: ${action.type}`,
      level: 1,
    });
    console.log("capturedElement", capturedElement);
    console.log("selector", selector);
    try {
      const timestamp = new Date().toISOString();
      let recordedAction: RecordedAction = {
        action: action.type,
        timestamp,
        success: result.success,
        details: {},
      };

      switch (action.type) {
        case "click":
        case "double_click":
        case "doubleClick": {
          const { x, y, button = "left" } = action;
          //let selector = null;
          this.logger({
            category: "agent",
            message: `Recording click action: ${x}, ${y}, ${button}`,
            level: 1,
          });

          // Use the element captured during click execution if available
          // if (capturedElement) {
          //   try {
          //     const elemData = JSON.parse(capturedElement);

          //     // Generate selector from captured element data
          //     if (elemData.id) {
          //       selector = elemData.id;
          //     } else if (
          //       elemData.tagName &&
          //       elemData.textContent &&
          //       elemData.textContent.length < 100
          //     ) {
          //       selector = `//${elemData.tagName}[text()="${elemData.textContent}"]`;
          //     } else {
          //       selector = elemData.outerHTML;
          //     }
          //   } catch (error) {
          //     // Fallback to outerHTML if JSON parsing fails
          //     this.logger({
          //       category: "agent",
          //       message: `Error parsing captured element: ${error}`,
          //       level: 0,
          //     });
          //     selector = capturedElement;
          //     selector = await this.generateSelector(x as number, y as number);
          //   }
          // } else {
          //   // Fallback to the old method if no captured element
          //   this.logger({
          //     category: "agent",
          //     message: "Falling back to generateSelector",
          //     level: 1,
          //   });
          //   selector = await this.generateSelector(x as number, y as number);
          // }

          recordedAction = {
            ...recordedAction,
            selector,
            details: {
              button: button as string,
              x: x as number,
              y: y as number,
            },
          };
          break;
        }

        case "type": {
          const { text } = action;
          const selector = await this.getActiveElementSelector();
          recordedAction = {
            ...recordedAction,
            selector,
            details: { text: text as string },
          };
          break;
        }

        case "keypress":
        case "key": {
          let keys: string[];
          if (action.type === "keypress" && Array.isArray(action.keys)) {
            keys = action.keys as string[];
          } else if (action.type === "key" && typeof action.text === "string") {
            // Convert Anthropic's 'key' action to standardized format
            keys = [action.text];
          } else {
            keys = [];
          }
          const selector = await this.getActiveElementSelector();
          recordedAction = {
            ...recordedAction,
            action: "keypress", // Standardize to keypress
            selector,
            details: { keys },
          };
          break;
        }

        case "scroll": {
          const { scroll_x = 0, scroll_y = 0 } = action;

          // Get the current cursor position
          const cursorPosition = await this.stagehandPage.page.evaluate(() => {
            return {
              x: window.__stagehandCursorX || 0,
              y: window.__stagehandCursorY || 0,
            };
          });

          // Get the selector for the element at the cursor position
          let selector = null;
          try {
            selector = await this.generateSelector(
              cursorPosition.x,
              cursorPosition.y,
            );
          } catch (error) {
            // If selector generation fails, continue without it
            this.logger({
              category: "agent",
              message: `Warning: Failed to generate selector for scroll action: ${error}`,
              level: 1,
            });
          }

          recordedAction = {
            ...recordedAction,
            action: "scrollElement",
            selector, // Element under the cursor (might be the scrolled element or a child)
            details: {
              deltaX: scroll_x as number,
              deltaY: scroll_y as number,
              x: cursorPosition.x,
              y: cursorPosition.y,
            },
          };
          break;
        }

        case "drag": {
          const dragPath = action.path as PathPoint[] | undefined;
          if (Array.isArray(dragPath) && dragPath.length >= 2) {
            const start = dragPath[0];
            const end = dragPath[dragPath.length - 1];

            // Try selector-based drag-and-drop first (fires HTML5 drag events)
            try {
              const sourceSelector = await this.generateSelector(start.x, start.y);
              const targetSelector = await this.generateSelector(end.x, end.y);

              const toPlaywrightSelector = (sel: string | null): string | null => {
                if (!sel) return null;
                return sel.startsWith("//") ? `xpath=${sel}` : sel;
              };

              const pwSource = toPlaywrightSelector(sourceSelector);
              const pwTarget = toPlaywrightSelector(targetSelector);

              if (pwSource && pwTarget) {
                await this.stagehandPage.page.dragAndDrop(pwSource, pwTarget, {
                  force: true,
                });
                result = { success: true };
                break;
              }
            } catch {
              // Fallback to mouse path dragging
            }

            // Fallback: simulate drag via mouse moves with small steps and delays
            await this.updateCursorPosition(start.x, start.y);
            await this.stagehandPage.page.mouse.move(start.x, start.y);
            await this.stagehandPage.page.mouse.down({ button: "left" });

            for (let i = 1; i < dragPath.length; i++) {
              const point = dragPath[i];
              await this.updateCursorPosition(point.x, point.y);
              await this.stagehandPage.page.mouse.move(point.x, point.y, { steps: 5 });
              // Small delay to ensure intermediate events fire (dragover, etc.)
              await new Promise((resolve) => setTimeout(resolve, 16));
            }

            await this.stagehandPage.page.mouse.up({ button: "left" });
          }
          result = { success: true };
          break;
        }

        case "move": {
          const { x, y } = action;
          const selector = await this.generateSelector(
            x as number,
            y as number,
          );
          recordedAction = {
            ...recordedAction,
            action: "hover", // More descriptive for Playwright
            selector,
            details: { x: x as number, y: y as number },
          };
          break;
        }

        case "wait": {
          recordedAction = {
            ...recordedAction,
            details: { duration: 1000 }, // Default duration used in executeAction
          };
          break;
        }

        case "function": {
          const { name, arguments: args = {} } = action;

          if (
            name === "goto" &&
            typeof args === "object" &&
            args !== null &&
            "url" in args
          ) {
            recordedAction = {
              ...recordedAction,
              action: "goto",
              details: { url: args.url as string },
            };
          } else if (name === "back") {
            recordedAction = {
              ...recordedAction,
              action: "goBack",
              details: {},
            };
          } else if (name === "forward") {
            recordedAction = {
              ...recordedAction,
              action: "goForward",
              details: {},
            };
          } else if (name === "reload") {
            recordedAction = {
              ...recordedAction,
              action: "reload",
              details: {},
            };
          }
          break;
        }

        // Ignore screenshot action as it's not relevant for replay
        case "screenshot":
          return; // Skip recording
      }

      // Add the action to the recorded actions array
      this.recordedActions.push(recordedAction);

      // No longer saving individual actions to separate files
      // Only saving the complete session at the end
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error recording action: ${error}`,
        level: 0,
      });
    }
  }

  /**
   * Save all recorded actions to a session file
   */
  async saveRecordedActions(): Promise<void> {
    try {
      if (this.recordedActions.length === 0) {
        this.logger({
          category: "agent",
          message: "No actions to save",
          level: 1,
        });
        return;
      }

      const dirPath = this.path.join(process.cwd(), "repeatables");
      const filePath = this.path.join(
        dirPath,
        `${this.sessionId}_complete.json`,
      );

      // Write all actions to a single file
      this.fs.writeFileSync(
        filePath,
        JSON.stringify(this.recordedActions, null, 2),
      );

      this.logger({
        category: "agent",
        message: `Saved ${this.recordedActions.length} actions to ${filePath}`,
        level: 1,
      });
    } catch (error) {
      this.logger({
        category: "agent",
        message: `Error saving recorded actions: ${error}`,
        level: 0,
      });
    }
  }
}
