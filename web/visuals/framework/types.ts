import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

// The visual contract (#157). A visual is a self-contained folder in web/visuals/<id>/ that exports one
// defineVisual({...}); the app provides the route, navigation, frame, settings panel and data hooks around it.
// See web/visuals/AGENTS.md.

/** lab: only in development (or with ?lab=1); beta: listed with a badge; stable: listed. */
export type VisualStatus = "lab" | "beta" | "stable";

interface SettingBase {
  label: string;
  help?: string;
}

export interface BooleanSetting extends SettingBase {
  type: "boolean";
  default: boolean;
}

export interface NumberSetting extends SettingBase {
  type: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

export interface EnumSetting<V extends string = string> extends SettingBase {
  type: "enum";
  default: V;
  options: readonly { value: V; label: string }[];
}

export type SettingSpec = BooleanSetting | NumberSetting | EnumSetting;
export type SettingsSchema = Record<string, SettingSpec>;

/** The resolved settings object for a schema: booleans, numbers and the enum's value union. */
export type SettingsOf<S extends SettingsSchema> = {
  [K in keyof S]: S[K] extends BooleanSetting
    ? boolean
    : S[K] extends NumberSetting
      ? number
      : S[K] extends EnumSetting<infer V>
        ? V
        : never;
};

export interface VisualProps<S extends SettingsSchema> {
  settings: SettingsOf<S>;
  /**
   * Unique per rendered instance (a page can show several visuals, or the same one twice). Use it for DOM ids and
   * anything else that must not collide.
   */
  instanceKey: string;
  /** True when shown on its own page (more room), false when embedded next to other visuals. */
  standalone: boolean;
}

export interface VisualDefinition<S extends SettingsSchema = SettingsSchema> {
  /** URL-safe, unique: the route is /v/<id>. */
  id: string;
  title: string;
  /** One or two sentences: shown under the title. */
  description: string;
  icon: LucideIcon;
  status: VisualStatus;
  settings: S;
  component: ComponentType<VisualProps<S>>;
  /** Longer explanation (how to read it, caveats), shown collapsed below the visual. Plain text paragraphs. */
  about?: string[];
}

export function defineVisual<S extends SettingsSchema>(def: VisualDefinition<S>): VisualDefinition<S> {
  return def;
}
