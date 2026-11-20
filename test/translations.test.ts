import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, checkTexts, type Reader, textsReport } from "../src/gate/translations.js";

// An in-memory repo: files at the head and the base, directory listings at the head, the bucket.
function mem(o: { head?: Record<string, string>; base?: Record<string, string>; dirs?: Record<string, string[]>; bucket?: Record<string, string>; fail?: string[] }): Reader {
  const failing = new Set(o.fail ?? []);
  return {
    head: (p) => (failing.has(p) ? undefined : (o.head?.[p] ?? null)),
    base: (p) => (failing.has(`base:${p}`) ? undefined : (o.base?.[p] ?? null)),
    list: (d) => (failing.has(`${d}/`) ? undefined : (o.dirs?.[d] ?? null)),
    bucket: (lc, ns) => o.bucket?.[`${lc}/${ns}`] ?? null,
  };
}

// A unified diff that adds lines to one file.
const diffOf = (file: string, ...lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1,2 @@", ...lines.map((l) => `+${l}`)].join("\n") + "\n";

const json = (o: Record<string, string>) => JSON.stringify(o, null, 4);
const all = (langs: string[], key: string, except: string[] = [], text = "x") =>
  Object.fromEntries(langs.map((l) => [l, json(except.includes(l) ? {} : { [key]: `${text} ${l}` })]));

const CLASSIC = ["en", "fi", "se", "da", "de", "fr", "nl", "no"];
const LOCALES = ["en-GB", "fi", "sv", "da", "no", "de", "fr", "nl"];

test("the diff's added lines, per file at the head", () => {
  const d = diffOf("a.php", "one", "two") + "diff --git a/b.php b/b.php\n--- a/b.php\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
  assert.deepEqual([...addedLines(d)], [["a.php", ["one", "two"]]]);
});

test("a diff with no texts says so and reads nothing", () => {
  const r = textsReport("portal", diffOf("src/a.ts", "const x = 1;"), () => mem({ fail: ["locales/"] }));
  assert.deepEqual(r, { failures: [], unreadable: [], remark: "translations: no new texts" });
});

// ---------------------------------------------------------------- classic

function classic(key: string, except: string[] = [], gapsHead?: string) {
  const area = Object.fromEntries(Object.entries(all(CLASSIC, key, except)).map(([l, s]) => [`resources/translations/portal/general/${l}.json`, s]));
  const gaps = json({}).replace("{}", '{ "missing": {} }');
  return mem({
    head: { ...area, "resources/translations/known-gaps.json": gapsHead ?? gaps },
    base: { "code/a.php": "<?php echo $l->old_key;", "resources/translations/known-gaps.json": gaps },
    dirs: { "resources/translations": ["known-gaps.json", "portal"], "resources/translations/portal": ["general"] },
  });
}

test("classic: a key the PR starts using, with all eight organiser languages, passes", () => {
  const r = textsReport("classic", diffOf("code/a.php", "echo $l->show_more;", "echo $l->lang('fi');"), () => classic("show_more"));
  assert.deepEqual(r.failures, []);
  assert.match(r.remark, /1 new key/);
});

test("classic: a key missing a language is refused, naming it", () => {
  const r = textsReport("classic", diffOf("code/a.php", "echo $l_show_more;"), () => classic("show_more", ["se", "no"]));
  assert.deepEqual(r.failures, ["translations: show_more has no text in se, no (resources/translations/portal/general)"]);
});

test("classic: a key in no area at all is refused", () => {
  const r = textsReport("classic", diffOf("code/a.php", "echo $l->get('nowhere');"), () => classic("show_more"));
  assert.deepEqual(r.failures, ["translations: nowhere is in no area of resources/translations"]);
});

test("classic: a key the base version of the file already used is not new", () => {
  const r = textsReport("classic", diffOf("code/a.php", "echo $l->old_key;"), () => classic("show_more"));
  assert.equal(r.remark, "translations: no new texts");
});

test("classic: known-gaps.json may not grow against the base", () => {
  const grown = '{ "missing": { "show_more": "fi da" } }';
  const r = textsReport("classic", diffOf("code/a.php", "echo 1;"), () => classic("show_more", [], grown));
  assert.deepEqual(r.failures, ["translations: show_more: known-gaps.json adds fi, da against the base"]);
});

test("classic: a JS file's message ids count only in a react-intl file", () => {
  const read = (head: string) => {
    const m = classic("show_more", ["fr"]);
    return { ...m, head: (p: string) => (p === "src/js/a.tsx" ? head : m.head(p)) };
  };
  const d = diffOf("src/js/a.tsx", "  more: { id: 'show_more', defaultMessage: 'Show more' },");
  assert.deepEqual(textsReport("classic", d, () => read("import { defineMessages } from 'react-intl';")).failures,
    ["translations: show_more has no text in fr (resources/translations/portal/general)"]);
  assert.equal(textsReport("classic", d, () => read("const a = { id: 'show_more' };")).remark, "translations: no new texts");
});

// ---------------------------------------------------------------- portal and public

function modules(ns: string, key: string, except: string[] = [], committed = true) {
  const files = Object.fromEntries(Object.entries(all(LOCALES, key, except)).map(([l, s]) => [`locales/${l}/${ns}.json`, s]));
  return committed
    ? mem({ head: files, dirs: { locales: LOCALES } })
    : mem({ bucket: Object.fromEntries(Object.entries(all(LOCALES, key, except)).map(([l, s]) => [`${l}/${ns}`, s])) });
}

test("portal: a t() key in every committed locale passes", () => {
  const r = textsReport("portal", diffOf("src/a.tsx", "<p>{t('website_editor_choose_design_show_more')}</p>"), () => modules("portal", "website_editor_choose_design_show_more"));
  assert.deepEqual(r.failures, []);
  assert.match(r.remark, /1 new key/);
});

test("portal: a key missing a locale is refused", () => {
  const r = textsReport("portal", diffOf("src/a.tsx", '<Trans i18nKey="show_more" />'), () => modules("portal", "show_more", ["nl"]));
  assert.deepEqual(r.failures, ["translations: show_more has no text in nl (portal)"]);
});

test("public: a branch with no committed locale files is checked against the bucket", () => {
  const ok = textsReport("public", diffOf("src/a.tsx", "t('see_more')"), () => modules("public", "see_more", [], false));
  assert.match(ok.remark, /bucket's public\.json/);
  const bad = textsReport("public", diffOf("src/a.tsx", "t('see_more')"), () => modules("public", "see_more", ["fi", "sv"], false));
  assert.deepEqual(bad.failures, ["translations: see_more has no text in fi, sv (public)"]);
});

test("portal: a key added to en-GB must be in every sibling locale", () => {
  const read = modules("portal", "other_key");
  const d = diffOf("locales/en-GB/portal.json", '    "brand_new": "Brand new",');
  assert.deepEqual(textsReport("portal", d, () => read).failures, ["translations: brand_new has no text in en-GB, fi, sv, da, no, de, fr, nl (portal)"]);
});

// ---------------------------------------------------------------- api

function api(key: string, except: string[] = []) {
  const files = Object.fromEntries(Object.entries(all(LOCALES, key, except)).map(([l, s]) => [`lang/${l}.json`, s]));
  return mem({ head: { ...files, "lang/en-GB/validation.php": "<?php return [];" }, dirs: { lang: [...LOCALES.map((l) => `${l}.json`), "en-GB"] } });
}

test("api: a __() key in every lang file passes, and a framework group key is not checked", () => {
  const r = textsReport("api", diffOf("app/A.php", "__('website_section_title');", "__('validation.in');"), () => api("website_section_title"));
  assert.deepEqual(r.failures, []);
  assert.match(r.remark, /1 new key/);
});

test("api: a __() key missing a language is refused", () => {
  const r = textsReport("api", diffOf("app/A.php", "return __('website_section_title');"), () => api("website_section_title", ["de"]));
  assert.deepEqual(r.failures, ["translations: website_section_title has no text in de (api)"]);
});

// ---------------------------------------------------------------- events

function events(key: string, except: string[] = []) {
  const langs = ["da", "de", "en", "fi", "fr", "nb", "nl", "sv"];
  const dir = "event_app/lib/src/localization";
  const files = Object.fromEntries(Object.entries(all(langs, key, except)).map(([l, s]) => [`${dir}/app_${l}.arb`, s]));
  return mem({ head: files, dirs: { [dir]: [...langs.map((l) => `app_${l}.arb`), "app_localizations.dart"] } });
}

test("events: an l10n key in every ARB file passes", () => {
  const r = textsReport("events", diffOf("event_app/lib/src/a.dart", "Text(context.l10n.showMore),"), () => events("showMore"));
  assert.deepEqual(r.failures, []);
  assert.match(r.remark, /1 new key/);
});

test("events: a key missing from an ARB file is refused", () => {
  const r = textsReport("events", diffOf("event_app/lib/src/a.dart", "Text(AppLocalizations.of(context)!.showMore),"), () => events("showMore", ["nb"]));
  assert.deepEqual(r.failures, ["translations: showMore has no text in nb (event_app)"]);
});

// ---------------------------------------------------------------- reads that fail

test("a read that fails is never a pass", () => {
  const r = textsReport("portal", diffOf("src/a.tsx", "t('show_more')"), () => mem({ fail: ["locales/"] }));
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.unreadable, ["COULD NOT READ locales/ -- translations not checked"]);
});

test("checkTexts names every key it looked at", () => {
  const v = checkTexts("portal", diffOf("src/a.tsx", "t('a_key'); t('b_key')"), modules("portal", "a_key"));
  assert.deepEqual(v.checked, ["a_key", "b_key"]);
  assert.deepEqual(v.missing, ["b_key has no text in en-GB, fi, sv, da, no, de, fr, nl (portal)"]);
});
