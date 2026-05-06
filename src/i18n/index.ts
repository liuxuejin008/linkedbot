import en from "./en";
import zh from "./zh";

export const dictionaries = { en, zh };
export type Lang = keyof typeof dictionaries;

export type TranslatorFunction = (key: keyof typeof en, args?: Record<string, string | number>) => string;

export function getTranslator(lang: Lang): TranslatorFunction {
  return function t(key: keyof typeof en, args?: Record<string, string | number>): string {
    const dict = dictionaries[lang] || dictionaries.en;
    let str = dict[key] || en[key] || key;
    
    if (args) {
      for (const [k, v] of Object.entries(args)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    
    return str;
  };
}
