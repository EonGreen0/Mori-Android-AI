import { triggerHaptic } from "../utils/index.js";
import { t } from "../i18n/index.js";

let activeSheet = null;

function optionIcon(kind) {
  const paths = {
    cache: "M4 4h16v5H4V4zm0 7h16v9H4v-9zm2 2v5h12v-5H6z",
    gallery: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h14V7H5zm2 8 3.2-4 2.3 2.8 1.6-1.9L18 15H7zm1-4.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
    trash: "M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z",
    more: "M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[kind] || paths.more);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

export function showActionSheet({
  title,
  message = "",
  options = [],
  cancelLabel = t("btn-cancel"),
} = {}) {
  activeSheet?.close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mori-action-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "moriActionTitle");

    const sheet = document.createElement("div");
    sheet.className = "mori-action-sheet";
    const heading = document.createElement("header");
    heading.className = "mori-action-heading";
    const headingTitle = document.createElement("strong");
    headingTitle.id = "moriActionTitle";
    headingTitle.textContent = String(title || "");
    heading.appendChild(headingTitle);
    if (message) {
      const headingMessage = document.createElement("p");
      headingMessage.textContent = String(message);
      heading.appendChild(headingMessage);
    }
    sheet.appendChild(heading);

    const group = document.createElement("div");
    group.className = "mori-action-group";
    options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mori-action-option${option.destructive ? " is-destructive" : ""}`;
      button.dataset.actionId = String(option.id || "");
      const icon = document.createElement("span");
      icon.className = "mori-action-option-icon";
      icon.appendChild(optionIcon(option.icon));
      const copy = document.createElement("span");
      copy.className = "mori-action-option-copy";
      const label = document.createElement("strong");
      label.textContent = String(option.label || "");
      copy.appendChild(label);
      if (option.description) {
        const description = document.createElement("small");
        description.textContent = String(option.description);
        copy.appendChild(description);
      }
      button.append(icon, copy);
      if (option.recommended) {
        const recommended = document.createElement("span");
        recommended.className = "mori-action-recommended";
        recommended.textContent = t("action-recommended");
        button.appendChild(recommended);
      }
      button.addEventListener("click", () => {
        try { triggerHaptic?.(option.destructive ? "warning" : "light"); } catch (_) {}
        close(option.id);
      });
      group.appendChild(button);
    });
    sheet.appendChild(group);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mori-action-cancel";
    cancel.textContent = cancelLabel;
    cancel.addEventListener("click", () => close(null));
    sheet.appendChild(cancel);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("is-visible"));

    let settled = false;
    let timer = null;
    const close = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      overlay.classList.remove("is-visible");
      timer = setTimeout(() => {
        overlay.remove();
        if (activeSheet?.overlay === overlay) activeSheet = null;
        resolve(value);
      }, 240);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") close(null);
    };
    activeSheet = { overlay, close };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKeyDown);
    if (!window.matchMedia?.("(pointer: coarse)")?.matches) {
      requestAnimationFrame(() => {
        sheet.querySelector("button")?.focus({ preventScroll: true });
      });
    }
  });
}
