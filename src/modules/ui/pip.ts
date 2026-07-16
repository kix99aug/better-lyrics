import { AppState } from "@core/appState";
import { LYRICS_CLASS, LYRICS_WRAPPER_ID } from "@constants";
import { calculateLyricPositions } from "@modules/lyrics/injectLyrics";

/**
 * Toggles the Document Picture-in-Picture window state.
 */
export async function togglePictureInPicture(): Promise<void> {
  if (AppState.pipWindow) {
    closePictureInPicture();
  } else {
    await openPictureInPicture();
  }
}

/**
 * Opens the lyrics in a Document Picture-in-Picture window.
 */
export async function openPictureInPicture(): Promise<void> {
  if (AppState.pipWindow) return;

  const lyricsWrapper = document.getElementById(LYRICS_WRAPPER_ID);
  if (!lyricsWrapper) {
    console.warn("[BetterLyrics] Cannot open Picture-in-Picture: lyrics wrapper not found.");
    return;
  }

  const pip = (window as any).documentPictureInPicture;
  if (!pip) {
    console.error("[BetterLyrics] Document Picture-in-Picture API is not supported in this browser.");
    return;
  }

  try {
    // Request always-on-top PiP window with compact height for 2 lines
    const pipWindow = await pip.requestWindow({
      width: 450,
      height: 130,
    });

    AppState.pipWindow = pipWindow;

    // Copy all inline style elements from the main document to the PiP window document
    [...document.querySelectorAll("style")].forEach((styleTag) => {
      const style = pipWindow.document.createElement("style");
      style.textContent = styleTag.textContent || "";
      pipWindow.document.head.appendChild(style);
    });

    // Fetch and inline all external/extension link stylesheets to bypass CSP in the PiP window
    for (const styleSheet of Array.from(document.styleSheets)) {
      if (styleSheet.href) {
        if (styleSheet.href.startsWith("chrome-extension://") || styleSheet.href.startsWith("moz-extension://")) {
          try {
            const cssText = await fetchAndInlineStylesheets(styleSheet.href);
            const style = pipWindow.document.createElement("style");
            style.textContent = cssText;
            pipWindow.document.head.appendChild(style);
          } catch (err) {
            console.warn("[BetterLyrics] Failed to inline extension stylesheet:", styleSheet.href, err);
          }
        } else {
          // For other stylesheets (e.g. Google Fonts), add them as link elements
          const link = pipWindow.document.createElement("link");
          link.rel = "stylesheet";
          link.type = styleSheet.type;
          link.media = styleSheet.media.mediaText;
          link.href = styleSheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    }

    // Ingress styles for body and container within PiP window
    pipWindow.document.body.style.margin = "0";
    pipWindow.document.body.style.padding = "0";
    pipWindow.document.body.style.overflow = "hidden";
    pipWindow.document.body.style.backgroundColor = "var(--ytmusic-background-black, #030303)";

    const pipTabRenderer = pipWindow.document.createElement("div");
    pipTabRenderer.id = "blyrics-pip-container";
    pipTabRenderer.style.width = "100%";
    pipTabRenderer.style.height = "100vh";
    pipTabRenderer.style.overflowY = "auto";
    pipTabRenderer.style.overflowX = "hidden";

    // Copy padding styles initially
    pipWindow.document.documentElement.style.setProperty(
      "--blyrics-padding-top",
      document.documentElement.style.getPropertyValue("--blyrics-padding-top")
    );
    pipWindow.document.documentElement.style.setProperty(
      "--blyrics-padding-bottom",
      document.documentElement.style.getPropertyValue("--blyrics-padding-bottom")
    );

    pipWindow.document.body.appendChild(pipTabRenderer);
    AppState.pipTabRenderer = pipTabRenderer;

    // Inject custom CSS styles specifically for styling within the PiP window
    const pipStyle = pipWindow.document.createElement("style");
    pipStyle.textContent = `
      #blyrics-wrapper {
        padding-left: 16px !important;
        padding-right: 16px !important;
        border: none !important;
        box-shadow: none !important;
      }
      #blyrics-wrapper .blyrics-footer {
        display: none !important;
      }
      #blyrics-pip-container {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
        user-select: none !important;
      }
      #blyrics-pip-container::-webkit-scrollbar {
        display: none !important;
      }
    `;
    pipWindow.document.head.appendChild(pipStyle);

    // Prevent mouse wheel, touchmove, and keyboard scroll actions
    const preventScrollDefault = (e: Event) => {
      e.preventDefault();
    };
    pipWindow.addEventListener("wheel", preventScrollDefault, { passive: false });
    pipWindow.addEventListener("touchmove", preventScrollDefault, { passive: false });
    pipWindow.addEventListener("keydown", (e: KeyboardEvent) => {
      const scrollKeys = ["ArrowUp", "ArrowDown", "Space", "PageUp", "PageDown", "Home", "End"];
      if (scrollKeys.includes(e.key) || scrollKeys.includes(e.code)) {
        e.preventDefault();
      }
    });

    // Create a placeholder where the lyrics wrapper originally was in the main window
    const placeholder = document.createElement("div");
    placeholder.id = "blyrics-pip-placeholder";
    lyricsWrapper.parentNode?.insertBefore(placeholder, lyricsWrapper);

    // Move the wrapper to the PiP window
    pipTabRenderer.appendChild(lyricsWrapper);
    lyricsWrapper.setAttribute("blyrics-pip-mode", "true");

    // Recalculate lyric layout for PiP size
    calculateLyricPositions();

    // Listen to resize of PiP window
    pipWindow.addEventListener("resize", () => {
      calculateLyricPositions();
    });

    // Cleanup when PiP window is closed
    pipWindow.addEventListener("pagehide", () => {
      closePictureInPicture();
    });
  } catch (error) {
    console.error("[BetterLyrics] Failed to open Document Picture-in-Picture window:", error);
    AppState.pipWindow = null;
    AppState.pipTabRenderer = null;
    AppState.isAutoPipActive = false;
  }
}

/**
 * Closes the Document Picture-in-Picture window and restores lyrics to the main page.
 */
export function closePictureInPicture(): void {
  const pipWindow = AppState.pipWindow;
  if (!pipWindow) return;

  AppState.pipWindow = null;
  AppState.pipTabRenderer = null;
  AppState.isAutoPipActive = false;

  const lyricsWrapper = pipWindow.document.getElementById(LYRICS_WRAPPER_ID);
  const placeholder = document.getElementById("blyrics-pip-placeholder");

  if (lyricsWrapper && placeholder) {
    lyricsWrapper.removeAttribute("blyrics-pip-mode");
    placeholder.parentNode?.insertBefore(lyricsWrapper, placeholder);
    placeholder.remove();
  }

  try {
    pipWindow.close();
  } catch (e) {
    // Window may already be closed
  }

  // Recalculate lyrics positioning for main tab size
  calculateLyricPositions();
}

/**
 * Recursively fetches and inlines stylesheet imports to bypass CSP inside the PiP window.
 */
async function fetchAndInlineStylesheets(url: string): Promise<string> {
  const response = await fetch(url);
  let cssText = await response.text();

  const importRegex = /@import\s+(?:url\s*\()?\s*['"]?([^'"\)]+)['"]?\s*\)?\s*;?/g;
  let match;
  const importsToResolve: { fullMatch: string; relativeUrl: string }[] = [];

  while ((match = importRegex.exec(cssText)) !== null) {
    importsToResolve.push({
      fullMatch: match[0],
      relativeUrl: match[1],
    });
  }

  for (const imp of importsToResolve) {
    if (imp.relativeUrl.startsWith("http://") || imp.relativeUrl.startsWith("https://")) {
      continue;
    }
    const absoluteUrl = new URL(imp.relativeUrl, url).toString();
    try {
      const inlinedCss = await fetchAndInlineStylesheets(absoluteUrl);
      cssText = cssText.replace(imp.fullMatch, inlinedCss);
    } catch (e) {
      console.warn("[BetterLyrics] Failed to resolve import:", absoluteUrl, e);
    }
  }

  return cssText;
}
