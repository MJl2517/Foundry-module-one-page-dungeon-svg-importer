import { MODULE_ID } from "./constants.js";
import { ImporterApp } from "./importer-app.js";

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Initializing`);
});

Hooks.on("renderSceneDirectory", (_app, element) => {
  addSceneDirectoryButton(element);
});

Hooks.on("renderApplicationV2", (app, element) => {
  if (app?.constructor?.name !== "SceneDirectory") return;
  addSceneDirectoryButton(element);
});

function addSceneDirectoryButton(element) {
  if (!game.user?.isGM) return;

  const root = normalizeElement(element);
  if (!root || root.querySelector(`[data-${MODULE_ID}-open]`)) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "watabou-opd-directory-button";
  button.dataset[`${camelCase(MODULE_ID)}Open`] = "true";
  button.title = game.i18n.localize("WatabouOPD.ImportButton");
  button.innerHTML = `<i class="fa-solid fa-file-import"></i><span>${game.i18n.localize("WatabouOPD.ImportButton")}</span>`;
  button.addEventListener("click", () => ImporterApp.open());

  const target = root.querySelector(".directory-header .header-actions")
    ?? root.querySelector(".directory-header")
    ?? root.querySelector("header")
    ?? root;
  target.appendChild(button);
}

function normalizeElement(element) {
  if (element instanceof HTMLElement) return element;
  if (element?.[0] instanceof HTMLElement) return element[0];
  if (element?.element instanceof HTMLElement) return element.element;
  if (element?.element?.[0] instanceof HTMLElement) return element.element[0];
  return null;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
