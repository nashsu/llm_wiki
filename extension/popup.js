const API_URLS = ["http://127.0.0.1:19827", "http://localhost:19827"];

const statusBar = document.getElementById("statusBar");
const titleInput = document.getElementById("titleInput");
const urlPreview = document.getElementById("urlPreview");
const contentPreview = document.getElementById("contentPreview");
const clipBtn = document.getElementById("clipBtn");
const projectSelect = document.getElementById("projectSelect");

let extractedContent = "";
let pageUrl = "";
let apiUrl = API_URLS[0];

async function clipFetch(path, options) {
  const method = String(options?.method || "GET").toUpperCase();
  // Only retry idempotent reads across host aliases. Retrying POST /clip can
  // duplicate a clip if the server handled the first request but the response
  // failed before the extension received it.
  const urls = method === "GET"
    ? [apiUrl, ...API_URLS.filter((url) => url !== apiUrl)]
    : [apiUrl];
  let lastError;

  for (const baseUrl of urls) {
    try {
      const res = await fetch(`${baseUrl}${path}`, options);
      apiUrl = baseUrl;
      return res;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to connect to LLM Wiki");
}

async function checkConnection() {
  try {
    const res = await clipFetch("/status", { method: "GET" });
    const data = await res.json();
    if (data.ok) {
      statusBar.className = "status connected";
      statusBar.textContent = "✓ Connected to LLM Wiki";
      await loadProjects();
      return true;
    }
  } catch {}
  statusBar.className = "status disconnected";
  statusBar.textContent = "✗ LLM Wiki app is not running";
  clipBtn.disabled = true;
  projectSelect.innerHTML = '<option value="">App not running</option>';
  return false;
}

async function loadProjects() {
  try {
    const res = await clipFetch("/projects", { method: "GET" });
    const data = await res.json();
    if (data.ok && data.projects?.length > 0) {
      projectSelect.innerHTML = "";
      for (const proj of data.projects) {
        const opt = document.createElement("option");
        opt.value = proj.path;
        opt.textContent = proj.name + (proj.current ? " (current)" : "");
        if (proj.current) opt.selected = true;
        projectSelect.appendChild(opt);
      }
      return;
    }
  } catch {}
  // Fallback to current project
  try {
    const res = await clipFetch("/project", { method: "GET" });
    const data = await res.json();
    if (data.ok && data.path) {
      const name = data.path.replace(/\\/g, "/").split("/").pop() || data.path;
      projectSelect.innerHTML = `<option value="${data.path}">${name}</option>`;
    }
  } catch {
    projectSelect.innerHTML = '<option value="">No projects</option>';
  }
}

async function extractContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    pageUrl = tab.url || "";
    titleInput.value = tab.title || "Untitled";
    urlPreview.textContent = pageUrl;

    // First inject Readability.js and Turndown.js into the page
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["Readability.js", "Turndown.js"],
    });

    // Then extract content using them
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          // Use Readability to extract article content
          const documentClone = document.cloneNode(true);
          const reader = new window.Readability(documentClone);
          const article = reader.parse();

          if (!article || !article.content) {
            return { error: "Readability could not extract content" };
          }

          // Use Turndown to convert HTML to Markdown
          const turndown = new window.TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
          });

          // Add table support
          turndown.addRule("tableCell", {
            filter: ["th", "td"],
            replacement: (content) => ` ${content.trim()} |`,
          });
          turndown.addRule("tableRow", {
            filter: "tr",
            replacement: (content) => `|${content}\n`,
          });
          turndown.addRule("table", {
            filter: "table",
            replacement: (content) => {
              // Add header separator after first row
              const lines = content.trim().split("\n");
              if (lines.length > 0) {
                const cols = (lines[0].match(/\|/g) || []).length - 1;
                const separator = "|" + " --- |".repeat(cols);
                lines.splice(1, 0, separator);
              }
              return "\n\n" + lines.join("\n") + "\n\n";
            },
          });

          // Remove images that are tracking pixels or tiny
          turndown.addRule("removeSmallImages", {
            filter: (node) => {
              if (node.nodeName !== "IMG") return false;
              const w = parseInt(node.getAttribute("width") || "999");
              const h = parseInt(node.getAttribute("height") || "999");
              return w < 10 || h < 10;
            },
            replacement: () => "",
          });

          const markdown = turndown.turndown(article.content);

          return {
            title: article.title,
            content: markdown,
            excerpt: article.excerpt || "",
            siteName: article.siteName || "",
            length: article.length || 0,
          };
        } catch (err) {
          return { error: err.message };
        }
      },
    });

    if (results?.[0]?.result) {
      const result = results[0].result;

      if (result.error) {
        contentPreview.textContent = `Extraction failed: ${result.error}. Falling back...`;
        await fallbackExtract(tab.id);
        return;
      }

      // Use Readability's title if better
      if (result.title && result.title.length > 5) {
        titleInput.value = result.title;
      }

      extractedContent = result.content;
      contentPreview.textContent = extractedContent;

      if (result.excerpt) {
        contentPreview.textContent = "📝 " + result.excerpt + "\n\n---\n\n" + extractedContent;
      }

      clipBtn.disabled = false;
    } else {
      await fallbackExtract(tab.id);
    }
  } catch (err) {
    contentPreview.textContent = `Error: ${err.message}`;
  }
}

// Fallback: simple DOM extraction if Readability fails
async function fallbackExtract(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.body.cloneNode(true);
      ["script", "style", "nav", "header", "footer", ".sidebar", ".ad", ".comments"]
        .forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));

      return clone.innerText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n\n")
        .slice(0, 50000);
    },
  });

  if (results?.[0]?.result) {
    extractedContent = results[0].result;
    contentPreview.textContent = extractedContent;
    clipBtn.disabled = false;
  } else {
    contentPreview.textContent = "Failed to extract content";
  }
}

async function sendClip() {
  const selectedProject = projectSelect.value;
  if (!selectedProject) {
    statusBar.className = "status error";
    statusBar.textContent = "✗ Please select a project";
    return;
  }

  clipBtn.disabled = true;
  statusBar.className = "status sending";
  statusBar.textContent = "⏳ Sending to LLM Wiki...";

  try {
    const res = await clipFetch("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: titleInput.value,
        url: pageUrl,
        content: extractedContent,
        projectPath: selectedProject,
      }),
    });

    const data = await res.json();

    if (data.ok) {
      const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || "project";
      statusBar.className = "status success";
      statusBar.textContent = `✓ Saved to ${projectName}`;
      clipBtn.textContent = "✓ Clipped!";
    } else {
      statusBar.className = "status error";
      statusBar.textContent = `✗ Error: ${data.error}`;
      clipBtn.disabled = false;
    }
  } catch (err) {
    statusBar.className = "status error";
    statusBar.textContent = `✗ Connection failed: ${err.message}`;
    clipBtn.disabled = false;
  }
}

clipBtn.addEventListener("click", sendClip);

// Resize content preview to fill available space without causing popup scroll
function resizePreview() {
  const totalHeight = 500; // matches html/body height
  const preview = document.getElementById("contentPreview");
  if (!preview) return;

  // Calculate space used by everything except the preview
  const previewRect = preview.getBoundingClientRect();
  const bottomSpace = totalHeight - previewRect.top - 60; // 60px for button + footer
  const maxH = Math.max(100, Math.min(300, bottomSpace));
  preview.style.maxHeight = maxH + "px";
}

(async () => {
  const connected = await checkConnection();
  // Always extract content so user can preview, even if app not running
  await extractContent();
  if (!connected) {
    clipBtn.disabled = true;
    clipBtn.textContent = "📎 App not running — cannot save";
  }
  setTimeout(resizePreview, 100);
})();
