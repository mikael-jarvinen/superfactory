// A message's text as HTML: Markdown as GitHub writes it (CommonMark, tables, strikethrough, task
// lists, bare URLs as links), parsed by marked and then cleaned by DOMPurify. Both are vendored next
// to this file, at the versions their headers name. What a message cannot do: raw HTML in it is shown
// as text, never rendered, and a link or an image goes only to http or https; any other scheme is
// left as the text that was written. Single line breaks stay line breaks, as before.
const md = (() => {
  const web = /^https?:\/\//i;
  const parser = new marked.Marked({gfm: true, breaks: true, renderer: {
    html: t => t.block ? `<p>${esc(t.text)}</p>` : esc(t.text),
    link(t){
      if(!web.test(t.href)) return esc(t.raw);
      const title = t.title ? ` title="${esc(t.title)}"` : '';
      return `<a href="${esc(t.href)}"${title} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(t.tokens)}</a>`;
    },
    image(t){
      if(!web.test(t.href)) return esc(t.raw);
      const title = t.title ? ` title="${esc(t.title)}"` : '';
      return `<img src="${esc(t.href)}" alt="${esc(t.text)}"${title} loading="lazy">`;
    },
  }});
  // The renderer already keeps to the rules; the sanitiser holds them whatever marked emits.
  DOMPurify.addHook('uponSanitizeAttribute', (_, a) => {
    if((a.attrName === 'href' || a.attrName === 'src') && !web.test(a.attrValue)) a.keepAttr = false;
  });
  return text => DOMPurify.sanitize(parser.parse(String(text ?? '')), {ADD_ATTR: ['target']});
})();
