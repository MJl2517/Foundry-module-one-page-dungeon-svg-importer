import { buildWatabouSceneImport } from "./svg-parser.js";
import { MODULE_ID, MODULE_PATH } from "./constants.js";

const DEFAULT_GRID_SIZE = 72;
const WATABOU_URL = "https://watabou.itch.io/one-page-dungeon";
const WATABOU_CAVES_URL = "https://watabou.github.io/cave-generator/";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ImporterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-importer`,
    classes: [MODULE_ID],
    window: {
      title: "WatabouOPD.ImportTitle",
      icon: "fa-solid fa-file-import",
      resizable: false
    },
    position: {
      width: 460,
      height: 1
    }
  };

  static PARTS = {
    main: {
      template: `${MODULE_PATH}/templates/importer.hbs`
    }
  };

  constructor(options = {}) {
    super(options);
    this.sceneName = "";
    this.gridSize = DEFAULT_GRID_SIZE;
    this.svgFile = null;
  }

  static open() {
    this.instance ??= new ImporterApp();
    this.instance.resetImportFields();
    return this.instance.render(true);
  }

  resetImportFields() {
    this.sceneName = "";
    this.svgFile = null;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      sceneName: this.sceneName,
      gridSize: this.gridSize
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    root.querySelector("[data-svg-file]")?.addEventListener("change", (event) => this.onFileSelected(event));
    this.bindDropzone();
    root.querySelector("[data-scene-name]")?.addEventListener("input", (event) => {
      this.sceneName = event.currentTarget.value;
    });
    root.querySelector("[data-grid-size]")?.addEventListener("input", (event) => {
      this.gridSize = normalizePositiveInteger(event.currentTarget.value, DEFAULT_GRID_SIZE);
    });
    root.querySelector("[data-help]")?.addEventListener("click", () => ImportHelpApp.open());
    root.querySelector("[data-open-watabou]")?.addEventListener("click", () => window.open(WATABOU_URL, "_blank", "noopener"));
    root.querySelector("[data-open-caves]")?.addEventListener("click", () => window.open(WATABOU_CAVES_URL, "_blank", "noopener"));
    root.querySelector("[data-cancel]")?.addEventListener("click", () => this.close());
    root.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.importSvg();
    });
    this.fitToContent();
  }

  fitToContent() {
    const schedule = window.requestAnimationFrame ?? ((callback) => window.setTimeout(callback, 0));
    schedule(() => {
      const app = this.element;
      const header = app?.querySelector(".window-header");
      const content = app?.querySelector(".window-content");
      const form = app?.querySelector(".watabou-opd-form");
      if (!app || !header || !content || !form) return;

      const contentStyle = window.getComputedStyle(content);
      const contentPadding = Number.parseFloat(contentStyle.paddingTop) + Number.parseFloat(contentStyle.paddingBottom);
      const desiredHeight = Math.ceil(header.offsetHeight + form.scrollHeight + contentPadding + 2);
      const maxHeight = Math.max(360, (window.innerHeight || desiredHeight) - 48);
      const height = Math.min(desiredHeight, maxHeight);

      app.classList.toggle("watabou-opd-is-scrollable", desiredHeight > maxHeight);
      if (typeof this.setPosition === "function") this.setPosition({ height });
    });
  }

  onFileSelected(event) {
    this.setSvgFile(event.currentTarget.files?.[0] ?? null);
  }

  bindDropzone() {
    const dropzone = this.element.querySelector("[data-dropzone]");
    if (!dropzone) return;

    dropzone.addEventListener("click", () => this.element.querySelector("[data-svg-file]")?.click());
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
    dropzone.addEventListener("dragleave", (event) => {
      if (dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove("is-dragging");
    });
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
      const file = [...event.dataTransfer?.files ?? []].find((candidate) => isSvgFile(candidate));
      if (!file) {
        ui.notifications.warn(game.i18n.localize("WatabouOPD.InvalidFileType"));
        return;
      }
      this.setSvgFile(file);
    });
  }

  setSvgFile(file) {
    this.svgFile = file;
    if (!this.svgFile) return;
    this.element.querySelector("[data-file-name]").textContent = this.svgFile.name;

    const baseName = this.svgFile.name.replace(/\.svg$/i, "").replace(/[_-]+/g, " ").trim();
    if (baseName) {
      this.sceneName = titleCase(baseName);
      const nameInput = this.element.querySelector("[data-scene-name]");
      if (nameInput) nameInput.value = this.sceneName;
    }
  }

  async importSvg() {
    if (!game.user?.isGM) {
      ui.notifications.error(game.i18n.localize("WatabouOPD.NotGm"));
      return;
    }

    if (!this.svgFile) {
      ui.notifications.warn(game.i18n.localize("WatabouOPD.NoFile"));
      return;
    }

    const submitButton = this.element.querySelector("[data-import]");
    submitButton?.setAttribute("disabled", "disabled");
    ui.notifications.info(game.i18n.localize("WatabouOPD.Importing"));

    try {
      const svgText = await this.svgFile.text();
      const sceneImport = buildWatabouSceneImport(svgText, {
        sceneName: this.sceneName,
        gridSize: this.gridSize
      });

      if (sceneImport.stats.doors === 0) {
        ui.notifications.warn(game.i18n.localize("WatabouOPD.MissingDoors"));
      }

      const backgroundPath = await uploadSvgFile(sceneImport.croppedSvg, sceneImport.fileName);
      const scene = await Scene.create({
        name: sceneImport.sceneName,
        width: sceneImport.width,
        height: sceneImport.height,
        padding: 0,
        background: {
          src: backgroundPath
        },
        grid: {
          type: CONST.GRID_TYPES.SQUARE,
          size: sceneImport.gridSize,
          distance: 5,
          units: "ft"
        },
        navigation: true,
        tokenVision: true,
        walls: sceneImport.walls,
        flags: {
          [MODULE_ID]: {
            source: "watabou-svg",
            svgGridSize: sceneImport.svgGridSize,
            gridSize: sceneImport.gridSize,
            requestedGridSize: sceneImport.requestedGridSize,
            floorPaths: sceneImport.stats.floorPaths,
            doors: sceneImport.stats.doors,
            secretDoors: sceneImport.stats.secretDoors,
            importedAt: new Date().toISOString()
          }
        }
      });

      ui.notifications.info(game.i18n.format("WatabouOPD.ImportComplete", {
        name: scene.name,
        walls: sceneImport.stats.walls,
        doors: sceneImport.stats.doors
      }));
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Import failed`, error);
      ui.notifications.error(error?.message ?? game.i18n.localize("WatabouOPD.InvalidSvg"));
    } finally {
      submitButton?.removeAttribute("disabled");
    }
  }
}

class ImportHelpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-import-help`,
    classes: [MODULE_ID, `${MODULE_ID}-help`],
    window: {
      title: "WatabouOPD.HelpTitle",
      icon: "fa-solid fa-circle-question",
      resizable: false
    },
    position: {
      width: 520,
      height: 470
    }
  };

  static PARTS = {
    main: {
      template: `${MODULE_PATH}/templates/import-help.hbs`
    }
  };

  static open() {
    this.instance ??= new ImportHelpApp();
    return this.instance.render(true);
  }
}

async function uploadSvgFile(svgText, fileName) {
  const FilePickerClass = foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;
  if (!FilePickerClass) throw new Error("Foundry FilePicker API was not found.");

  const target = `worlds/${game.world.id}/${MODULE_ID}`;
  try {
    await FilePickerClass.createDirectory("data", target, { notify: false });
  } catch (error) {
    if (!String(error?.message ?? error).toLowerCase().includes("exist")) throw error;
  }

  const file = new File([svgText], fileName, { type: "image/svg+xml" });
  const response = await FilePickerClass.upload("data", target, file, { notify: false });
  return response?.path ?? `${target}/${fileName}`;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isSvgFile(file) {
  return file?.type === "image/svg+xml" || /\.svg$/i.test(file?.name ?? "");
}

function titleCase(value) {
  return value.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}
