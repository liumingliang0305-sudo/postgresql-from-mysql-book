(() => {
  "use strict";

  const DEFAULT_DOCUMENT = "chapters/00-preface.md";
  const BOOK_VERSION = "PostgreSQL 18";

  const elements = {
    article: document.querySelector("#article-content"),
    articleMeta: document.querySelector("#article-meta"),
    chapterCount: document.querySelector("#chapter-count"),
    main: document.querySelector("#main-content"),
    menuButton: document.querySelector("#menu-button"),
    navigation: document.querySelector("#book-navigation"),
    pageToc: document.querySelector("#page-toc"),
    pager: document.querySelector("#chapter-pager"),
    progress: document.querySelector("#reading-progress"),
    scrim: document.querySelector("#sidebar-scrim"),
    sidebar: document.querySelector("#book-sidebar"),
  };

  const state = {
    activeAnchor: "",
    activeDocument: "",
    chapters: [],
    sections: [],
    scrollFrame: null,
  };

  const slugCounts = new Map();

  function slugify(text) {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[`*_~]/g, "")
      .replace(/[\s]+/g, "-")
      .replace(/[：:，,。！？?、；;（）()【】\[\]“”‘’'"《》<>/\\]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    const count = slugCounts.get(base) || 0;
    slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function configureMarked() {
    if (!window.marked) {
      throw new Error("Markdown 渲染器未能加载");
    }

    const renderer = {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const plainText = text.replace(/<[^>]*>/g, "");
        const id = slugify(plainText);

        return `<h${depth} id="${escapeHtml(id)}"><a class="heading-anchor" href="#${encodeURI(id)}">${text}</a></h${depth}>`;
      },
    };

    window.marked.use({
      gfm: true,
      breaks: false,
      renderer,
    });
  }

  async function fetchText(file) {
    const response = await fetch(file, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`无法读取 ${file}`);
    }
    return response.text();
  }

  function parseBookNavigation(markdown) {
    const sections = [];
    let currentSection = null;

    for (const sourceLine of markdown.split("\n")) {
      const line = sourceLine.trim();
      const sectionMatch = line.match(/^###\s+(.+)$/);
      if (sectionMatch) {
        currentSection = {
          title: sectionMatch[1].trim(),
          chapters: [],
        };
        sections.push(currentSection);
        continue;
      }

      const linkMatch = line.match(/^-\s+\[([^\]]+)\]\(([^)#]+\.md)(?:#([^)]*))?\)$/);
      if (!linkMatch || !currentSection) continue;

      const chapter = {
        title: linkMatch[1].trim(),
        file: linkMatch[2],
        anchor: linkMatch[3] ? decodeURIComponent(linkMatch[3]) : "",
        section: currentSection.title,
      };

      currentSection.chapters.push(chapter);
    }

    return sections.filter((section) => section.chapters.length > 0);
  }

  function renderNavigation() {
    elements.navigation.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const section of state.sections) {
      const wrapper = document.createElement("section");
      wrapper.className = "nav-section";

      const heading = document.createElement("h2");
      heading.className = "nav-section__title";
      heading.textContent = section.title;
      wrapper.append(heading);

      const list = document.createElement("ul");
      list.className = "nav-section__list";

      for (const chapter of section.chapters) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nav-link";
        button.textContent = chapter.title;
        button.dataset.file = chapter.file;
        button.dataset.anchor = chapter.anchor;
        button.addEventListener("click", () => navigateTo(chapter));
        item.append(button);
        list.append(item);
      }

      wrapper.append(list);
      fragment.append(wrapper);
    }

    elements.navigation.append(fragment);
    const numberedChapterCount = state.chapters.filter((chapter) =>
      /^第\s*\d+\s*章/.test(chapter.title),
    ).length;
    elements.chapterCount.textContent = `${numberedChapterCount} 章`;
  }

  function currentLocation() {
    const url = new URL(window.location.href);
    const requestedDocument = url.searchParams.get("doc") || DEFAULT_DOCUMENT;
    const file = state.chapters.some((chapter) => chapter.file === requestedDocument)
      ? requestedDocument
      : DEFAULT_DOCUMENT;

    return {
      file,
      anchor: decodeURIComponent(url.hash.replace(/^#/, "")),
    };
  }

  function updateUrl(chapter, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("doc", chapter.file);
    url.hash = chapter.anchor ? encodeURI(chapter.anchor) : "";
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  }

  async function navigateTo(chapter, options = {}) {
    const { replace = false, updateHistory = true } = options;
    if (updateHistory) updateUrl(chapter, replace);

    if (state.activeDocument !== chapter.file) {
      await loadDocument(chapter.file, chapter.anchor);
    } else {
      scrollToAnchor(chapter.anchor);
      setActiveChapter(chapter.anchor);
      updateArticleMeta(chapter.file, chapter.anchor);
      renderPager(chapter.anchor);
      document.title = `${activeTitle(chapter.file, chapter.anchor)} · 从 MySQL 到 PostgreSQL`;
    }

    closeSidebar();
  }

  async function loadDocument(file, anchor = "") {
    showLoading();
    state.activeDocument = file;
    state.activeAnchor = anchor;
    slugCounts.clear();

    try {
      const markdown = await fetchText(file);
      const html = window.marked.parse(markdown);
      elements.article.innerHTML = html;
      hardenRenderedContent();
      decorateCodeBlocks();
      buildPageToc();
      renderPager(anchor);
      updateArticleMeta(file, anchor);
      setActiveChapter(anchor);
      document.title = `${activeTitle(file, anchor)} · 从 MySQL 到 PostgreSQL`;

      requestAnimationFrame(() => {
        if (anchor) {
          scrollToAnchor(anchor);
        } else {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
        updateReadingProgress();
      });
    } catch (error) {
      showError(error instanceof Error ? error.message : "页面加载失败");
    }
  }

  function hardenRenderedContent() {
    elements.article
      .querySelectorAll("script, iframe, object, embed, form")
      .forEach((node) => node.remove());

    for (const node of elements.article.querySelectorAll("*")) {
      for (const attribute of [...node.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          node.removeAttribute(attribute.name);
        }
      }
    }

    for (const link of elements.article.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      if (/^javascript:/i.test(href)) {
        link.removeAttribute("href");
        continue;
      }

      if (/^https?:\/\//i.test(href)) {
        link.target = "_blank";
        link.rel = "noreferrer";
      }
    }
  }

  function decorateCodeBlocks() {
    for (const pre of elements.article.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (!code) continue;

      const languageClass = [...code.classList].find((name) =>
        name.startsWith("language-"),
      );
      if (languageClass) {
        const label = document.createElement("span");
        label.className = "code-language";
        label.textContent = languageClass.replace("language-", "");
        pre.append(label);
      }

      const button = document.createElement("button");
      button.className = "copy-code";
      button.type = "button";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码");
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent || "");
          button.textContent = "已复制";
          window.setTimeout(() => {
            button.textContent = "复制";
          }, 1400);
        } catch {
          button.textContent = "复制失败";
        }
      });
      pre.append(button);
    }
  }

  function buildPageToc() {
    elements.pageToc.replaceChildren();
    const fragment = document.createDocumentFragment();
    const headings = elements.article.querySelectorAll("h2, h3");

    for (const heading of headings) {
      const link = document.createElement("a");
      link.className = `toc-link toc-link--${heading.tagName.toLowerCase()}`;
      link.href = `#${encodeURI(heading.id)}`;
      link.textContent = heading.textContent.replace(/#$/, "").trim();
      link.dataset.anchor = heading.id;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const url = new URL(window.location.href);
        url.hash = encodeURI(heading.id);
        window.history.pushState({}, "", url);
        scrollToAnchor(heading.id);
      });
      fragment.append(link);
    }

    elements.pageToc.append(fragment);
  }

  function activeTitle(file, anchor) {
    const chapter = findChapter(file, anchor);
    if (chapter) return chapter.title;
    const heading = elements.article.querySelector("h1");
    return heading ? heading.textContent.trim() : "从 MySQL 到 PostgreSQL";
  }

  function findChapter(file, anchor) {
    return (
      state.chapters.find(
        (chapter) => chapter.file === file && chapter.anchor === anchor,
      ) || state.chapters.find((chapter) => chapter.file === file)
    );
  }

  function setActiveChapter(anchor) {
    state.activeAnchor = anchor;
    for (const link of elements.navigation.querySelectorAll(".nav-link")) {
      const matches =
        link.dataset.file === state.activeDocument &&
        (link.dataset.anchor === anchor ||
          (!anchor &&
            findChapter(state.activeDocument, "")?.anchor === link.dataset.anchor));
      link.classList.toggle("is-active", matches);
      if (matches) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    for (const link of elements.pageToc.querySelectorAll(".toc-link")) {
      link.classList.toggle("is-active", link.dataset.anchor === anchor);
    }
  }

  function updateArticleMeta(file, anchor) {
    const chapter = findChapter(file, anchor);
    elements.articleMeta.innerHTML = "";

    const part = document.createElement("span");
    part.textContent = chapter?.section || "正文";
    const rule = document.createElement("span");
    rule.className = "article-meta__rule";
    const version = document.createElement("span");
    version.textContent = BOOK_VERSION;
    elements.articleMeta.append(part, rule, version);
  }

  function renderPager(anchor) {
    elements.pager.replaceChildren();
    let activeIndex = state.chapters.findIndex(
      (chapter) =>
        chapter.file === state.activeDocument && chapter.anchor === anchor,
    );

    if (activeIndex < 0) {
      activeIndex = state.chapters.findIndex(
        (chapter) => chapter.file === state.activeDocument,
      );
    }

    const previous = state.chapters[activeIndex - 1];
    const next = state.chapters[activeIndex + 1];
    if (previous) elements.pager.append(createPagerLink(previous, "上一篇", "←"));
    if (next) elements.pager.append(createPagerLink(next, "下一篇", "→"));
  }

  function createPagerLink(chapter, label, arrow) {
    const link = document.createElement("a");
    link.className = "pager-link";
    link.href = buildHref(chapter);
    link.innerHTML = `<small>${label} ${arrow}</small><strong>${escapeHtml(chapter.title)}</strong>`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateTo(chapter);
    });
    return link;
  }

  function buildHref(chapter) {
    const url = new URL(window.location.href);
    url.searchParams.set("doc", chapter.file);
    url.hash = chapter.anchor ? encodeURI(chapter.anchor) : "";
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function scrollToAnchor(anchor) {
    if (!anchor) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const target = document.getElementById(anchor);
    if (target) target.scrollIntoView({ block: "start" });
  }

  function showLoading() {
    elements.article.innerHTML = `
      <div class="article-loading" aria-label="正在加载正文">
        <span class="loading-line loading-line--short"></span>
        <span class="loading-line"></span>
        <span class="loading-line"></span>
        <span class="loading-line loading-line--medium"></span>
      </div>`;
    elements.pageToc.replaceChildren();
    elements.pager.replaceChildren();
  }

  function showError(message) {
    elements.article.innerHTML = `
      <div class="article-error" role="alert">
        <h1>正文没有加载成功</h1>
        <p>${escapeHtml(message)}。请确认页面通过网站服务器访问，而不是直接双击本地 HTML 文件。</p>
      </div>`;
  }

  function openSidebar() {
    elements.sidebar.classList.add("is-open");
    elements.scrim.classList.add("is-visible");
    elements.menuButton.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    elements.sidebar.classList.remove("is-open");
    elements.scrim.classList.remove("is-visible");
    elements.menuButton.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }

  function updateReadingProgress() {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const value = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
    elements.progress.style.width = `${Math.min(100, Math.max(0, value))}%`;
  }

  function updateActiveHeading() {
    const headings = [...elements.article.querySelectorAll("h2")];
    if (headings.length === 0) return;

    const marker = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-height"),
    );
    const threshold = Number.isFinite(marker) ? marker * 16 + 32 : 112;
    let active = headings[0];

    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= threshold) active = heading;
      else break;
    }

    if (active.id !== state.activeAnchor) {
      setActiveChapter(active.id);
      updateArticleMeta(state.activeDocument, active.id);
      renderPager(active.id);
    }

    const tocHeadings = [...elements.article.querySelectorAll("h2, h3")];
    let activeToc = tocHeadings[0];
    for (const heading of tocHeadings) {
      if (heading.getBoundingClientRect().top <= threshold) activeToc = heading;
      else break;
    }
    for (const link of elements.pageToc.querySelectorAll(".toc-link")) {
      link.classList.toggle("is-active", link.dataset.anchor === activeToc?.id);
    }
  }

  function onScroll() {
    if (state.scrollFrame) return;
    state.scrollFrame = window.requestAnimationFrame(() => {
      updateReadingProgress();
      updateActiveHeading();
      state.scrollFrame = null;
    });
  }

  async function initialize() {
    try {
      configureMarked();
      const readme = await fetchText("README.md");
      state.sections = parseBookNavigation(readme);
      state.chapters = state.sections.flatMap((section) => section.chapters);
      renderNavigation();

      const location = currentLocation();
      await navigateTo(
        {
          file: location.file,
          anchor: location.anchor,
          title: "",
          section: "",
        },
        { updateHistory: false },
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "初始化失败");
    }
  }

  elements.menuButton.addEventListener("click", () => {
    if (elements.sidebar.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  elements.scrim.addEventListener("click", closeSidebar);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("popstate", async () => {
    const location = currentLocation();
    await navigateTo(
      { file: location.file, anchor: location.anchor, title: "", section: "" },
      { updateHistory: false },
    );
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
