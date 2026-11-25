// Translations at the PR head: every text key the PR adds or starts using has a non-empty text in
// every language the repo ships.
//
// Nothing reaches your-review or colleague-review without its translations, so nothing merges
// without them. So pr-ready refuses on a miss, and pr-open-for-review asks the same, for a PR that
// never went through pr-send. Nothing turns it off: a false positive is fixed here, in the patterns
// or the ignore lists, never by an environment variable.
//
// Two rules, per repo shape:
//   - a key the diff's added lines start using (it is not used in the base version of that file)
//     must have a text in every language;
//   - a key added to the base language's locale file must be in every sibling locale file.
// A diff with neither prints "translations: no new texts" and reads nothing more.
import type { Repo } from "../config.js";
import { run } from "../util.js";
import { gh, json } from "./github.js";

export type Shape = "classic" | "portal" | "public" | "api" | "events";

// The repos' keys in factory.toml.
export const SHAPES: Record<string, Shape> = { classic: "classic", portal: "portal", public: "public", api: "api", events: "events" };

// What the checker reads. null is "absent at that commit", undefined is "could not read".
export interface Reader {
  head(path: string): string | null | undefined;
  base(path: string): string | null | undefined;
  list(dir: string): string[] | null | undefined;
  bucket(locale: string, ns: string): string | null | undefined;
}

export interface TextsVerdict {
  // The keys looked at, for the remark.
  checked: string[];
  // One line per key with a miss, naming the languages.
  missing: string[];
  // Reads that failed: the check is not done until they succeed.
  unreadable: string[];
  // Said whatever the outcome, such as which bucket a branch without locale files was checked against.
  notes: string[];
}

// ---------------------------------------------------------------- the diff

// The added lines of each file the diff changes, by its path at the head. Deleted files have none.
export function addedLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) file = null;
    else if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, []);
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) out.get(file)!.push(line.slice(1));
  }
  return out;
}

const matches = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1] as string);

// ---------------------------------------------------------------- the shapes

const CLASSIC_LANGS = ["en", "fi", "se", "da", "de", "fr", "nl", "no"];
const MODULES_LOCALES = ["en-GB", "fi", "sv", "da", "no", "de", "fr", "nl"];
const PLURAL = ["zero", "one", "two", "few", "many", "other"];

// Names that look like keys and are not. Each one was a false positive on a real PR; add here, never
// switch the check off.
const CLASSIC_IGNORE = new Set<string>([
  // $l-> methods and properties of LegacyTranslations
  "lang", "get", "isTranslated", "getCurrentLanguage",
]);
const EVENTS_IGNORE = new Set<string>(["localeName"]);

interface Use {
  key: string;
  // Which locale set the key belongs to: classic "", the modules' namespace, events' app directory.
  group: string;
}

// The keys a file's text uses, by the repo's own conventions.
function uses(shape: Shape, file: string, text: string): Use[] {
  if (shape === "classic") {
    if (/^(www\/common\/lang|resources\/translations)\//.test(file) || /LegacyTranslationsDocs\.php$/.test(file)) return [];
    if (/\.php$/.test(file)) {
      const keys = [
        ...matches(/\$l_([A-Za-z0-9_]+)/g, text),
        ...matches(/\$l->([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g, text),
        ...matches(/\$l->(?:get|isTranslated)\(\s*['"]([A-Za-z0-9_]+)['"]/g, text),
      ];
      return keys.filter((k) => !CLASSIC_IGNORE.has(k)).map((key) => ({ key, group: "" }));
    }
    // Message ids; checkTexts counts them only in a file that uses react-intl, read whole.
    if (/\.(js|jsx|ts|tsx)$/.test(file)) return matches(/\bid:\s*['"]([a-z0-9_]+)['"]/g, text).map((key) => ({ key, group: "" }));
    return [];
  }
  if (shape === "portal" || shape === "public") {
    if (!/\.(js|jsx|ts|tsx)$/.test(file) || /^locales\//.test(file)) return [];
    const raw = [...matches(/(?<![\w.$])t\(\s*['"]([^'"`$]+?)['"]/g, text), ...matches(/i18nKey=\s*\{?\s*['"]([^'"]+)['"]/g, text)];
    return raw.map((k) => {
      const i = k.indexOf(":");
      return i > 0 ? { key: k.slice(i + 1), group: k.slice(0, i) } : { key: k, group: shape };
    });
  }
  if (shape === "api") {
    if (!/\.php$/.test(file) || /^lang\//.test(file)) return [];
    return matches(/(?:\b__|\btrans|\btrans_choice|@lang|Lang::get)\(\s*['"]([^'"]+)['"]/g, text).map((key) => ({ key, group: "" }));
  }
  // events
  const app = file.split("/")[0] as string;
  if (!/\.dart$/.test(file) || !/^(event_app|admin_web)$/.test(app)) return [];
  return [...matches(/\bl10n\.([a-z][A-Za-z0-9]*)\b/g, text), ...matches(/AppLocalizations\.of\([^)]*\)!?\.([a-z][A-Za-z0-9]*)\b/g, text)]
    .filter((k) => !EVENTS_IGNORE.has(k))
    .map((key) => ({ key, group: app }));
}

// Keys added to a base-language locale file: the sibling rule.
function addedToBaseLocale(shape: Shape, file: string, lines: string[]): Use[] {
  const keyOf = (l: string) => /^\s*"([^"@][^"]*)"\s*:/.exec(l)?.[1];
  const keys = () => lines.map(keyOf).filter((k): k is string => !!k);
  let m: RegExpExecArray | null;
  if (shape === "classic" && (m = /^resources\/translations\/([^/]+\/[^/]+)\/en\.json$/.exec(file))) return keys().map((key) => ({ key, group: m![1] as string }));
  if ((shape === "portal" || shape === "public") && (m = /^locales\/en-GB\/([^/]+)\.json$/.exec(file))) return keys().map((key) => ({ key, group: m![1] as string }));
  if (shape === "api" && file === "lang/en-GB.json") return keys().map((key) => ({ key, group: "" }));
  if (shape === "events" && (m = /^(event_app|admin_web)\/lib\/src\/localization\/app_en\.arb$/.exec(file))) return keys().map((key) => ({ key, group: m![1] as string }));
  if (shape === "events" && file === "functions/src/platform/i18n/en.json") return keys().map((key) => ({ key, group: "functions" }));
  return [];
}

// ---------------------------------------------------------------- the locale data at the head

type Texts = Record<string, unknown>;

// One language's texts: the language, and the file they came from, for the message.
interface Locale {
  lang: string;
  texts: Texts;
}

const hasText = (texts: Texts, key: string): boolean => {
  const v = texts[key];
  if (typeof v === "string") return v.trim().length > 0;
  if (v && typeof v === "object") return Object.values(v).some((x) => typeof x === "string" && x.trim().length > 0);
  // i18next plurals: key_one, key_other
  return PLURAL.some((p) => typeof texts[`${key}_${p}`] === "string" && (texts[`${key}_${p}`] as string).trim().length > 0);
};

const parse = (s: string): Texts | undefined => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Texts) : undefined;
  } catch {
    return undefined;
  }
};

class Locales {
  private cache = new Map<string, Locale[] | undefined>();
  constructor(private shape: Shape, private read: Reader, private v: TextsVerdict) {}

  private file(path: string, lang: string): Locale | null | undefined {
    const s = this.read.head(path);
    if (s === undefined) return void this.v.unreadable.push(path);
    if (s === null) return null;
    const texts = parse(s);
    if (!texts) return void this.v.unreadable.push(`${path} (not a JSON object)`);
    return { lang, texts };
  }

  // Every language of a group, or undefined when something could not be read.
  of(group: string): Locale[] | undefined {
    if (!this.cache.has(group)) this.cache.set(group, this.load(group));
    return this.cache.get(group);
  }

  private load(group: string): Locale[] | undefined {
    const files = (paths: [string, string][]) => {
      const out: Locale[] = [];
      for (const [path, lang] of paths) {
        const l = this.file(path, lang);
        if (l === undefined) return undefined;
        out.push(l ?? { lang, texts: {} });
      }
      return out;
    };
    if (this.shape === "classic") {
      // group "" is a used key, whose area is found below; "<scope>/<area>" is an area itself.
      if (group) return files(CLASSIC_LANGS.map((l) => [`resources/translations/${group}/${l}.json`, l]));
      return undefined;
    }
    if (this.shape === "portal" || this.shape === "public" || this.shape === "api") {
      const committed = this.shape === "api" ? this.read.list("lang") : this.read.list("locales");
      if (committed === undefined) return void this.v.unreadable.push(this.shape === "api" ? "lang/" : "locales/");
      const pathOf = (lc: string) => (this.shape === "api" ? `lang/${lc}.json` : `locales/${lc}/${group}.json`);
      const lcs = this.shape === "api" ? (committed ?? []).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)) : (committed ?? []);
      if (lcs.length) return files(lcs.map((lc) => [pathOf(lc), lc]));
      // A branch from before the texts moved into the repo: the bucket the app read them from.
      const ns = this.shape === "api" ? "api" : group;
      this.v.notes.push(`no committed locale files at the head; checked against the bucket's ${ns}.json`);
      const out: Locale[] = [];
      for (const lc of MODULES_LOCALES) {
        const s = this.read.bucket(lc, ns);
        if (s === undefined) return void this.v.unreadable.push(`bucket ${lc}/${ns}.json`);
        const texts = s === null ? {} : parse(s);
        if (!texts) return void this.v.unreadable.push(`bucket ${lc}/${ns}.json (not a JSON object)`);
        out.push({ lang: lc, texts });
      }
      return out;
    }
    // events: an app's ARB files, or the functions' JSON
    const dir = group === "functions" ? "functions/src/platform/i18n" : `${group}/lib/src/localization`;
    const names = this.read.list(dir);
    if (names === undefined) return void this.v.unreadable.push(`${dir}/`);
    const pat = group === "functions" ? /^([a-z]{2}(?:[-_][A-Za-z]+)?)\.json$/ : /^app_([a-z]{2}(?:_[A-Za-z]+)?)\.arb$/;
    return files((names ?? []).flatMap((n) => {
      const m = pat.exec(n);
      return m ? [[`${dir}/${n}`, m[1] as string] as [string, string]] : [];
    }));
  }

  // classic: every area and its languages, read once.
  private areas?: { area: string; locales: Locale[] }[] | undefined;
  private areasRead = false;
  classicAreas(): { area: string; locales: Locale[] }[] | undefined {
    if (!this.areasRead) {
      this.areas = this.readAreas();
      this.areasRead = true;
    }
    return this.areas;
  }

  private readAreas(): { area: string; locales: Locale[] }[] | undefined {
    const scopes = this.read.list("resources/translations");
    if (scopes === undefined) return void this.v.unreadable.push("resources/translations/");
    if (scopes === null) return [];
    const out: { area: string; locales: Locale[] }[] = [];
    for (const scope of scopes.filter((s) => !s.endsWith(".json"))) {
      const areas = this.read.list(`resources/translations/${scope}`);
      if (areas === undefined) return void this.v.unreadable.push(`resources/translations/${scope}/`);
      for (const area of areas ?? []) {
        const locales = this.of(`${scope}/${area}`);
        if (!locales) return undefined;
        out.push({ area: `${scope}/${area}`, locales });
      }
    }
    return out;
  }

  // classic before the scoped files: the generated language files.
  classicLegacy(): Locale[] | undefined {
    if (!this.cache.has("legacy")) this.cache.set("legacy", (() => {
      const out: Locale[] = [];
      for (const l of CLASSIC_LANGS) {
        const f = this.file(`www/common/lang/${l}.json`, l);
        if (f === undefined) return undefined;
        out.push(f ?? { lang: l, texts: {} });
      }
      return out;
    })());
    return this.cache.get("legacy");
  }
}

// ---------------------------------------------------------------- the check

export function checkTexts(shape: Shape, diff: string, read: Reader): TextsVerdict {
  const v: TextsVerdict = { checked: [], missing: [], unreadable: [], notes: [] };
  const added = addedLines(diff);

  // The keys to check, grouped. A used key counts only if the base version of its file did not use it.
  const wanted = new Map<string, Set<string>>();
  const want = (u: Use) => {
    if (!wanted.has(u.group)) wanted.set(u.group, new Set());
    wanted.get(u.group)!.add(u.key);
  };
  for (const [file, lines] of added) {
    for (const u of addedToBaseLocale(shape, file, lines)) want(u);
    const fresh = uses(shape, file, lines.join("\n"));
    if (!fresh.length) continue;
    // A classic JS file is read whole, since whether it uses react-intl may be above the diff.
    if (shape === "classic" && /\.(js|jsx|ts|tsx)$/.test(file)) {
      const whole = read.head(file);
      if (whole === undefined) {
        v.unreadable.push(file);
        continue;
      }
      if (!whole || !/react-intl|defineMessages|formatMessage/.test(whole)) continue;
    }
    const before = read.base(file);
    if (before === undefined) {
      v.unreadable.push(`${file} at the base`);
      continue;
    }
    const old = new Set((before ? uses(shape, file, before) : []).map((u) => `${u.group}\0${u.key}`));
    for (const u of fresh) if (!old.has(`${u.group}\0${u.key}`)) want(u);
  }

  if (shape === "classic") classicGaps(read, v);
  if (!wanted.size || v.unreadable.length) return v;

  const loc = new Locales(shape, read, v);
  const miss = (key: string, langs: string[], where: string) => v.missing.push(`${key} has no text in ${langs.join(", ")} (${where})`);

  for (const [group, keys] of wanted) {
    for (const key of [...keys].sort()) {
      v.checked.push(key);
      if (shape === "classic" && !group) {
        const areas = loc.classicAreas();
        if (!areas) return v;
        const inArea = areas.filter((a) => (a.locales.find((l) => l.lang === "en")?.texts ?? {})[key] !== undefined);
        if (areas.length && !inArea.length) {
          v.missing.push(`${key} is in no area of resources/translations`);
          continue;
        }
        if (!areas.length) {
          // classic before the scoped files
          const legacy = loc.classicLegacy();
          if (!legacy) return v;
          const langs = legacy.filter((l) => !hasText(l.texts, key)).map((l) => l.lang);
          if (langs.length) miss(key, langs, "www/common/lang");
          continue;
        }
        for (const a of inArea) {
          const langs = a.locales.filter((l) => !hasText(l.texts, key)).map((l) => l.lang);
          if (langs.length) miss(key, langs, `resources/translations/${a.area}`);
        }
        continue;
      }
      // api keys in a PHP group file, such as validation.in, are the framework's: not checked here.
      if (shape === "api" && /^[a-z_]+\.[\w.]+$/.test(key)) {
        const group0 = key.split(".")[0];
        const php = read.head(`lang/en-GB/${group0}.php`);
        if (php === undefined) {
          v.unreadable.push(`lang/en-GB/${group0}.php`);
          return v;
        }
        if (php !== null) {
          v.checked.pop();
          continue;
        }
      }
      const locales = loc.of(group);
      if (!locales) return v;
      if (!locales.length) {
        v.missing.push(`${key}: no locale files for ${group || shape} at the head`);
        continue;
      }
      const langs = locales.filter((l) => !hasText(l.texts, key)).map((l) => l.lang);
      if (langs.length) miss(key, langs, group && shape !== "api" ? group : shape);
    }
  }
  return v;
}

// classic's known-gaps.json may only shrink: a gap the base does not list is a text this PR skipped.
function classicGaps(read: Reader, v: TextsVerdict): void {
  const path = "resources/translations/known-gaps.json";
  const head = read.head(path);
  if (head === undefined) return void v.unreadable.push(path);
  if (head === null) return;
  const base = read.base(path);
  if (base === undefined) return void v.unreadable.push(`${path} at the base`);
  const pairs = (s: string | null) => {
    const m = ((s && parse(s)?.missing) ?? {}) as Record<string, string>;
    return new Set(Object.entries(m).flatMap(([k, langs]) => String(langs).split(/\s+/).filter(Boolean).map((l) => `${k} ${l}`)));
  };
  const before = pairs(base);
  const grew = [...pairs(head)].filter((p) => !before.has(p));
  if (!grew.length) return;
  const byKey = new Map<string, string[]>();
  for (const p of grew) {
    const [k, l] = p.split(" ") as [string, string];
    byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  for (const [k, langs] of byKey) v.missing.push(`${k}: known-gaps.json adds ${langs.join(", ")} against the base`);
}

// ---------------------------------------------------------------- reading GitHub

const BUCKET = "https://storage.googleapis.com/lyyti-lokalise-translations-public";

const notFound = (stderr: string) => /\b404\b|Not Found/i.test(stderr);

export function githubReader(repo: Repo, head: string, base: string): Reader {
  const url = (path: string, ref: string) => `repos/${repo.remote}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`;
  const raw = (path: string, ref: string) => {
    const r = gh("api", url(path, ref), "-H", "Accept: application/vnd.github.raw");
    if (r.status === 0) return r.stdout;
    return notFound(r.stderr + r.stdout) ? null : undefined;
  };
  return {
    head: (path) => raw(path, head),
    base: (path) => raw(path, base),
    list: (dir) => {
      const r = gh("api", url(dir, head));
      if (r.status !== 0) return notFound(r.stderr + r.stdout) ? null : undefined;
      const entries = json<{ name: string }[]>(r);
      return Array.isArray(entries) ? entries.map((e) => e.name) : undefined;
    },
    bucket: (locale, ns) => fetchBucket(`${BUCKET}/${locale}/${ns}.json`),
  };
}

// The public bucket the modules read their texts from before the texts moved into the repos.
function fetchBucket(u: string): string | null | undefined {
  const r = run("curl", ["-sS", "-f", "--max-time", "60", u]);
  if (r.status === 0) return r.stdout;
  return r.status === 22 && /404/.test(r.stderr) ? null : undefined;
}

export interface TextsReport {
  failures: string[];
  unreadable: string[];
  remark: string;
}

// The check at a PR's head, as pr-ready and pr-open-for-review say it: the failures they refuse on,
// the reads that failed, and the remark when it passes.
export function translationsAt(repo: Repo, head: string, base: string, diff: string | undefined): TextsReport {
  return textsReport(SHAPES[repo.key], diff, () => githubReader(repo, head, base));
}

export function textsReport(shape: Shape | undefined, diff: string | undefined, read: () => Reader): TextsReport {
  if (!shape) return { failures: [], unreadable: [], remark: "translations: not checked, the repo has no known text conventions" };
  if (diff === undefined) return { failures: [], unreadable: ["COULD NOT READ the diff -- translations not checked"], remark: "" };
  const v = checkTexts(shape, diff, read());
  const note = v.notes.length ? ` (${[...new Set(v.notes)].join("; ")})` : "";
  if (v.unreadable.length) return { failures: [], unreadable: v.unreadable.map((p) => `COULD NOT READ ${p} -- translations not checked`), remark: "" };
  if (v.missing.length) return { failures: v.missing.map((m) => `translations: ${m}`), unreadable: [], remark: "" };
  if (!v.checked.length) return { failures: [], unreadable: [], remark: `translations: no new texts${note}` };
  return { failures: [], unreadable: [], remark: `translations: ${v.checked.length} new key(s), each with a text in every language${note}` };
}
