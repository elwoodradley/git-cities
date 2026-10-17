import { Color } from "three";
import { hash01 } from "./rng";

export interface Theme {
  name: string;
  background: Color;
  fog: Color;
  ground: Color;
  grid: Color;
  district: Color;
  /** Colour for a building given its extension and directory. */
  building: (ext: string, dir: string) => Color;
  /** Glow colour when a building is touched. */
  heat: Color;
  /** Author drone palette (cycled). */
  authors: Color[];
  ambient: Color;
  key: Color;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** Extra CRT post pass (scanlines, phosphor, curvature). */
  crt: boolean;
  ui: { fg: string; dim: string; accent: string; panel: string };
}

const extGroups: Record<string, string[]> = {
  script: ["js", "ts", "jsx", "tsx", "mjs", "cjs", "vue", "svelte"],
  python: ["py", "pyi", "pyx", "ipynb"],
  systems: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "rs", "go", "zig", "m", "mm", "swift", "java", "kt", "cs"],
  shell: ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "makefile", "mk", "perl", "pl", "pm", "rb", "lua", "php"],
  docs: ["md", "rst", "txt", "adoc", "tex", "html", "htm", "xml", "1", "pod", "texi"],
  config: ["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "lock", "gitignore", "editorconfig", "env", "properties"],
  style: ["css", "scss", "sass", "less", "styl"],
  data: ["csv", "tsv", "sql", "png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "woff2", "ttf", "pdf", "bin"],
};
const extToGroup = new Map<string, string>();
for (const [g, exts] of Object.entries(extGroups)) for (const e of exts) extToGroup.set(e, g);

export function extGroup(ext: string): string {
  return extToGroup.get(ext) ?? "other";
}

function palette(colors: Record<string, string>, fallbackHue: (dir: string) => Color) {
  const map = new Map(Object.entries(colors).map(([k, v]) => [k, new Color(v)]));
  return (ext: string, dir: string): Color => map.get(extGroup(ext)) ?? fallbackHue(dir);
}

const neon: Theme = {
  name: "neon",
  background: new Color("#06030f"),
  fog: new Color("#0a0618"),
  ground: new Color("#0b0718"),
  grid: new Color("#2a1b4d"),
  district: new Color("#140b2c"),
  building: palette(
    {
      script: "#22d3ee",
      python: "#a78bfa",
      systems: "#f472b6",
      shell: "#fb923c",
      docs: "#fbbf24",
      config: "#4ade80",
      style: "#f472b6",
      data: "#60a5fa",
    },
    (dir) => new Color().setHSL(hash01(dir), 0.7, 0.6),
  ),
  heat: new Color("#ffffff"),
  authors: ["#22d3ee", "#f472b6", "#a78bfa", "#fbbf24", "#4ade80", "#fb923c", "#60a5fa", "#f87171", "#2dd4bf", "#e879f9", "#facc15", "#38bdf8"].map((c) => new Color(c)),
  ambient: new Color("#2b1d57"),
  key: new Color("#c4b5fd"),
  bloomStrength: 0.8,
  bloomRadius: 0.4,
  bloomThreshold: 0.6,
  crt: false,
  ui: { fg: "#ede9fe", dim: "#8b7fb8", accent: "#22d3ee", panel: "rgba(10, 6, 24, 0.72)" },
};

const crt: Theme = {
  name: "crt",
  background: new Color("#020603"),
  fog: new Color("#03130a"),
  ground: new Color("#031208"),
  grid: new Color("#0f3d1f"),
  district: new Color("#062211"),
  building: (ext, dir) => {
    // Monochrome phosphor: vary brightness by group so districts still read.
    const g = extGroup(ext);
    const l = { script: 0.55, python: 0.5, systems: 0.6, shell: 0.42, docs: 0.36, config: 0.3, style: 0.48, data: 0.26, other: 0.3 + 0.2 * hash01(dir) }[g] ?? 0.4;
    return new Color().setHSL(0.36, 0.95, l);
  },
  heat: new Color("#d9ffd0"),
  authors: ["#9dff9d", "#e8ffb0", "#5cff8a", "#c2ffc2", "#7bffd6", "#b9ff5c", "#e0ffe0", "#4bffb0"].map((c) => new Color(c)),
  ambient: new Color("#0a3a1a"),
  key: new Color("#7dffa8"),
  bloomStrength: 0.7,
  bloomRadius: 0.35,
  bloomThreshold: 0.7,
  crt: true,
  ui: { fg: "#b8ffc4", dim: "#3f9a5a", accent: "#7dffa8", panel: "rgba(2, 12, 5, 0.7)" },
};

const ember: Theme = {
  name: "ember",
  background: new Color("#0a0303"),
  fog: new Color("#140606"),
  ground: new Color("#120505"),
  grid: new Color("#3a1410"),
  district: new Color("#1f0a08"),
  building: palette(
    {
      script: "#fbbf24",
      python: "#f97316",
      systems: "#ef4444",
      shell: "#fb7185",
      docs: "#fde68a",
      config: "#f59e0b",
      style: "#f472b6",
      data: "#a3a3a3",
    },
    (dir) => new Color().setHSL(0.02 + 0.12 * hash01(dir), 0.8, 0.55),
  ),
  heat: new Color("#fff7ed"),
  authors: ["#fbbf24", "#fb7185", "#f97316", "#fde68a", "#f472b6", "#ef4444", "#fcd34d", "#fdba74"].map((c) => new Color(c)),
  ambient: new Color("#3a1410"),
  key: new Color("#fdba74"),
  bloomStrength: 0.8,
  bloomRadius: 0.4,
  bloomThreshold: 0.6,
  crt: false,
  ui: { fg: "#fff1e6", dim: "#a8705a", accent: "#fbbf24", panel: "rgba(20, 6, 4, 0.72)" },
};

export const themes: Record<string, Theme> = { neon, crt, ember };

export function getTheme(name: string | null | undefined): Theme {
  return themes[name ?? ""] ?? neon;
}
