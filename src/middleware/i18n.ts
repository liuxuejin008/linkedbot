import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { getTranslator, Lang, dictionaries } from "../i18n";
import type { AppEnv } from "../types";

export const i18nMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // 1. Check query parameter
  const queryLang = c.req.query("lang");
  let lang: Lang | null = null;

  if (queryLang && queryLang in dictionaries) {
    lang = queryLang as Lang;
    // Save to cookie if specified via query
    setCookie(c, "lang", lang, { path: "/", maxAge: 31536000 }); // 1 year
  }

  // 2. Check cookie
  if (!lang) {
    const cookieLang = getCookie(c, "lang");
    if (cookieLang && cookieLang in dictionaries) {
      lang = cookieLang as Lang;
    }
  }

  // 3. Check Accept-Language header
  if (!lang) {
    const acceptLang = c.req.header("Accept-Language");
    if (acceptLang) {
      // Very basic parsing, prioritize Chinese if zh is present, else default to en
      if (acceptLang.toLowerCase().includes("zh")) {
        lang = "zh";
      } else {
        lang = "en";
      }
    }
  }

  // 4. Default to en
  if (!lang) {
    lang = "en";
  }

  const t = getTranslator(lang);
  c.set("lang", lang);
  c.set("t", t);

  await next();
});
