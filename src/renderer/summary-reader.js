"use strict";

(function summaryReaderModule(root) {
  const mounts = new WeakMap();
  const NS = "http://www.w3.org/2000/svg";
  const COLORS = ["#237c89", "#ac5b73", "#697c35", "#8865a3", "#bb7039", "#427ca7", "#827348", "#52846d"];

  function timestamp(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
      .slice(value >= 3600 ? 0 : 1).map(n => String(n).padStart(2, "0")).join(":");
  }

  function dispose(container) {
    mounts.get(container)?.controller.destroy();
    mounts.delete(container);
  }

  function render(container, summary, options = {}) {
    if (!container || !summary) return null;
    const signature = JSON.stringify([options.sessionId || "", summary]);
    const previous = mounts.get(container);
    if (previous?.signature === signature && previous.controller.element.parentElement === container) return previous.controller;
    dispose(container);
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    let alive = true;
    const current = () => alive && (typeof options.isCurrent !== "function" || options.isCurrent());
    const create = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = String(text);
      return node;
    };
    const svgNode = (tag, attributes = {}) => {
      const node = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    };
    const button = (label, icon, action) => {
      const node = create("button", "summary-tool");
      node.type = "button";
      node.title = label;
      node.setAttribute("aria-label", label);
      node.appendChild(create("span", `ui-icon icon-${icon}`));
      node.firstChild.setAttribute("aria-hidden", "true");
      node.addEventListener("click", action);
      return node;
    };

    const element = create("div", "summary-reader");
    element.dataset.view = "map";
    const tabs = create("div", "summary-reader-tabs");
    tabs.setAttribute("role", "tablist");
    const tabButtons = [];
    for (const [key, label] of [["map", "内容脉络"], ["article", "整理正文"]]) {
      const tab = create("button", null, label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", () => view(key));
      tabs.appendChild(tab);
      tabButtons.push([key, tab]);
    }
    function view(key) {
      element.dataset.view = key;
      for (const [name, tab] of tabButtons) {
        tab.setAttribute("aria-selected", String(key === name));
        tab.tabIndex = key === name ? 0 : -1;
      }
    }
    tabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const key = event.key === "Home" ? "map" : event.key === "End" ? "article"
        : element.dataset.view === "map" ? "article" : "map";
      view(key);
      tabButtons.find(([name]) => name === key)[1].focus();
    });
    view("map");
    const layout = create("div", "summary-reader-layout");
    const mapPane = create("section", "summary-reader-map-pane");
    mapPane.setAttribute("aria-label", "内容脉络");
    const mapHeader = create("header", "summary-reader-map-header");
    mapHeader.appendChild(create("h3", null, "内容脉络"));
    const tools = create("div", "summary-map-tools");
    const zoomLabel = create("output", "summary-map-scale", "100%");
    let transform = { x: 0, y: 0, k: 1 };
    let bounds = null;
    let autoFit = true;
    let zoomTimer = null;
    const canvas = create("div", "summary-map-canvas");
    const svg = svgNode("svg", { role: "tree", "aria-label": summary.title || "思维导图" });
    const scene = svgNode("g");
    svg.appendChild(scene);
    canvas.appendChild(svg);
    function applyTransform() {
      scene.setAttribute("transform", `translate(${transform.x},${transform.y}) scale(${transform.k})`);
      zoomLabel.textContent = `${Math.round(transform.k * 100)}%`;
    }
    function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
      autoFit = false;
      const next = Math.max(0.06, Math.min(3, transform.k * factor));
      transform.x = x - (x - transform.x) * next / transform.k;
      transform.y = y - (y - transform.y) * next / transform.k;
      transform.k = next;
      applyTransform();
    }
    function fit() {
      if (!bounds || !canvas.clientWidth || !canvas.clientHeight) return;
      autoFit = true;
      const k = Math.max(0.06, Math.min(1, (canvas.clientWidth - 36) / bounds.width, (canvas.clientHeight - 36) / bounds.height));
      transform = { k, x: (canvas.clientWidth - bounds.width * k) / 2 - bounds.left * k,
        y: (canvas.clientHeight - bounds.height * k) / 2 - bounds.top * k };
      applyTransform();
    }
    tools.append(button("缩小", "zoom-out", () => zoom(1 / 1.2)), zoomLabel,
      button("放大", "zoom-in", () => zoom(1.2)), button("适合窗口", "expand", fit));
    mapHeader.appendChild(tools);
    mapPane.append(mapHeader, canvas);
    layout.appendChild(mapPane);

    const article = create("article", "summary-reader-article");
    article.setAttribute("aria-label", "整理正文");
    article.tabIndex = 0;
    const heading = create("h2", "summary-reader-title", summary.title || "内容整理");
    article.appendChild(heading);
    const chapters = new Map();
    let audio = null;
    let playbackUrl = "";
    let playbackExpiresAt = 0;
    let playbackRequest = 0;
    let pendingTime = null;
    const audioArea = create("div", "summary-source-player");
    audioArea.hidden = true;
    const audioStatus = create("span", "summary-source-status");
    audioStatus.setAttribute("role", "status");
    const audioTrack = create("select", "summary-source-track");
    audioTrack.setAttribute("aria-label", "回听音轨");
    for (const [value, text] of [["auto", "自动选择音轨"], ["microphone", "麦克风录音"], ["system", "系统声音录音"]]) {
      const opt = create("option", null, text);
      opt.value = value;
      audioTrack.appendChild(opt);
    }
    audioTrack.addEventListener("change", () => {
      playbackRequest++;
      playbackUrl = "";
      audio?.pause();
      if (audio) { audio.removeAttribute("src"); audio.load(); }
      audioStatus.textContent = "请选择原文时间回听";
    });
    audioArea.append(audioTrack, audioStatus);
    async function seek(seconds) {
      audioArea.hidden = false;
      const request = ++playbackRequest;
      try {
        if (!options.sessionId || typeof options.api?.meetingPlaybackToken !== "function") throw new Error("unavailable");
        audioStatus.textContent = "正在打开本地录音…";
        if (!playbackUrl || Date.now() >= playbackExpiresAt) {
          const token = await options.api.meetingPlaybackToken({ sessionId: options.sessionId, track: audioTrack.value });
          if (!current() || request !== playbackRequest) return;
          if (!token?.ok || !/^mimo-meeting:\/\/play\/[a-f0-9]{48}$/.test(token.url)) throw new Error("unavailable");
          playbackUrl = token.url;
          playbackExpiresAt = Number(token.expiresAt) || Date.now() + 60000;
        }
        if (!current() || request !== playbackRequest) return;
        if (!audio) {
          audio = create("audio", "summary-source-audio");
          audio.controls = true;
          audio.preload = "metadata";
          audio.addEventListener("loadedmetadata", () => {
            if (!current() || pendingTime == null) return;
            audio.currentTime = Math.min(pendingTime, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.01) : pendingTime);
            pendingTime = null;
          });
          audio.addEventListener("error", () => { if (current()) audioStatus.textContent = "录音无法播放，仍可查看下方原文依据"; });
          audioArea.appendChild(audio);
        }
        pendingTime = Math.max(0, seconds);
        if (audio.getAttribute("src") !== playbackUrl) audio.src = playbackUrl;
        else if (audio.readyState >= 1) { audio.currentTime = Math.min(pendingTime, Math.max(0, audio.duration - 0.01)); pendingTime = null; }
        audioStatus.textContent = `原文位置 ${timestamp(seconds)}`;
        await audio.play();
      } catch {
        if (current() && request === playbackRequest) audioStatus.textContent = "未能回听本地录音，可查看原文依据或使用播放器重试";
      }
    }
    function evidence(parent, claim) {
      if (claim?.uncertain) parent.appendChild(create("small", "summary-uncertain", "待确认，请核对原文"));
      const sources = Array.isArray(claim?.provenance) ? claim.provenance.filter(item => typeof item?.quote === "string" && item.quote).slice(0, 64) : [];
      if (!sources.length) return;
      const details = create("details", "summary-source-evidence");
      details.appendChild(create("summary", null, `原文依据 · ${sources.length}`));
      for (const source of sources) {
        const sourceLine = create("div", "summary-source-reference");
        const validTime = Number.isFinite(source.startFrame) && source.startFrame >= 0
          && Number.isFinite(summary.sampleRate) && summary.sampleRate > 0;
        const start = validTime ? source.startFrame / summary.sampleRate : 0;
        if (validTime) {
          const label = timestamp(start) + (Number.isFinite(source.endFrame) ? ` – ${timestamp(source.endFrame / summary.sampleRate)}` : "");
          const link = create("button", "summary-source-seek", label);
          link.type = "button";
          link.title = "回听对应的原始录音";
          link.addEventListener("click", () => { void seek(start); });
          sourceLine.appendChild(link);
        }
        sourceLine.appendChild(create("span", "summary-source-kind", source.source === "mimo" ? "MiMo 复核" : "原始转写"));
        sourceLine.appendChild(create("blockquote", null, source.quote));
        details.appendChild(sourceLine);
      }
      parent.appendChild(details);
    }
    if (summary.overview?.text) {
      const overview = create("section", "summary-reader-overview");
      overview.append(create("h3", null, "内容概览"), create("p", "summary-reader-paragraph", summary.overview.text));
      evidence(overview, summary.overview);
      article.appendChild(overview);
    }
    for (const [index, section] of (summary.sections || []).slice(0, 30).entries()) {
      const block = create("section", "summary-reader-chapter");
      const chapterId = `section-${index + 1}`;
      block.dataset.sectionId = chapterId;
      const h = create("h3", "summary-reader-chapter-heading", section.heading);
      h.tabIndex = -1;
      block.appendChild(h);
      chapters.set(chapterId, block);
      for (const paragraph of (section.paragraphs || []).slice(0, 200)) {
        const body = create("div", "summary-reader-claim");
        body.appendChild(create("p", "summary-reader-paragraph", paragraph.text));
        evidence(body, paragraph);
        block.appendChild(body);
      }
      article.appendChild(block);
    }
    article.insertBefore(audioArea, heading.nextSibling);
    function navigate(id) {
      view("article");
      const block = chapters.get(id) || heading;
      for (const [key, chapter] of chapters) chapter.classList.toggle("summary-chapter-active", key === id);
      block.scrollIntoView({ block: "start", behavior: win.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      (block.querySelector?.("h3") || heading).focus({ preventScroll: true });
    }
    layout.appendChild(article);
    element.append(tabs, layout);
    container.replaceChildren(element);

    const collapsed = new Set();
    let budget = 200;
    const copyTree = (input, id = "root", depth = 0, sectionId = "") => {
      if (!input || --budget < 0 || depth > 8) return null;
      const value = { text: String(input.text || "").slice(0, 160), id, sectionId, uncertain: input.uncertain === true };
      value.children = (input.children || []).slice(0, 200).map((child, i) => copyTree(child, `${id}-${i}`, depth + 1,
        depth === 0 ? `section-${i + 1}` : sectionId)).filter(Boolean);
      return value;
    };
    const tree = copyTree(summary.mindmap);
    // Start larger maps at chapter level so labels remain readable on entry.
    if (tree && budget < 188) for (const branch of tree.children) {
      if (branch.children.length) collapsed.add(branch.id);
    }
    const context = doc.createElement("canvas").getContext("2d");
    if (context) context.font = "14px sans-serif";
    function linesFor(text) {
      const lines = [];
      let line = "";
      for (const char of text) {
        if (line && (context ? context.measureText(line + char).width : (line.length + 1) * 14) > 176) { lines.push(line); line = ""; }
        line += char;
      }
      if (line) lines.push(line);
      return lines.length ? lines : [""];
    }
    const d3 = options.hierarchy || win.d3;
    function draw() {
      scene.replaceChildren();
      if (!tree || !d3?.hierarchy || !d3?.tree) {
        canvas.replaceChildren(create("p", "summary-map-unavailable", "导图布局未加载，正文仍可正常阅读"));
        return;
      }
      const data = d3.hierarchy(tree, node => collapsed.has(node.id) ? null : node.children);
      let height = 50;
      data.each(node => {
        node.lines = linesFor(node.data.text);
        node.boxHeight = node.lines.length * 19 + 22;
        height = Math.max(height, node.boxHeight);
      });
      d3.tree().nodeSize([height + 20, 258])(data);
      const nodes = data.descendants();
      const color = node => {
        let branch = node;
        while (branch.parent && branch.parent.depth > 0) branch = branch.parent;
        return branch.depth ? COLORS[(data.children || []).indexOf(branch) % COLORS.length] : "#304a51";
      };
      for (const link of data.links()) {
        const sx = link.source.y + 212, sy = link.source.x, tx = link.target.y, ty = link.target.x;
        scene.appendChild(svgNode("path", { d: `M${sx},${sy} C${(sx + tx) / 2},${sy} ${(sx + tx) / 2},${ty} ${tx},${ty}`,
          fill: "none", stroke: color(link.target), "stroke-width": 1.8, opacity: 0.65 }));
      }
      for (const [index, node] of nodes.entries()) {
        const g = svgNode("g", { transform: `translate(${node.y},${node.x})`, role: "treeitem", tabindex: 0,
          "aria-label": node.data.text, "aria-level": node.depth + 1, "data-node-id": node.data.id,
          "data-section-id": node.data.sectionId, class: "summary-map-node" });
        if (node.data.children.length) g.setAttribute("aria-expanded", String(!collapsed.has(node.data.id)));
        g.appendChild(svgNode("rect", { x: 0, y: -node.boxHeight / 2, width: 212, height: node.boxHeight, rx: 6,
          fill: node.depth < 2 ? color(node) : "#ffffff", "fill-opacity": node.depth < 2 ? 0.1 : 0.8,
          stroke: color(node), "stroke-opacity": node.depth < 2 ? 0.3 : 0.12 }));
        const label = svgNode("text", { x: 13, y: -(node.lines.length - 1) * 19 / 2 + 5, fill: color(node),
          "font-size": 14, "font-weight": node.depth < 2 ? 600 : 400 });
        node.lines.forEach((line, i) => {
          const span = svgNode("tspan", { x: 13, dy: i ? 19 : 0 });
          span.textContent = line;
          label.appendChild(span);
        });
        g.appendChild(label);
        if (node.data.uncertain) g.appendChild(svgNode("circle", { cx: 202, cy: -node.boxHeight / 2 + 8, r: 3, fill: "#b66c2d" }));
        function toggle(force) {
          if (!node.data.children.length) return;
          const closed = force ?? !collapsed.has(node.data.id);
          if (closed) collapsed.add(node.data.id); else collapsed.delete(node.data.id);
          draw();
          if (autoFit) fit();
          scene.querySelector(`[data-node-id="${node.data.id}"]`)?.focus({ preventScroll: true });
        }
        g.addEventListener("click", () => navigate(node.data.sectionId));
        g.addEventListener("keydown", event => {
          if (event.target !== g) return;
          if (["Enter", " "].includes(event.key)) { event.preventDefault(); navigate(node.data.sectionId); }
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); toggle(event.key === "ArrowLeft"); }
          if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            const target = nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)))];
            scene.querySelector(`[data-node-id="${target.data.id}"]`)?.focus();
          }
        });
        if (node.data.children.length) {
          const foreign = svgNode("foreignObject", { x: 199, y: -12, width: 25, height: 25 });
          const collapse = button(collapsed.has(node.data.id) ? "展开分支" : "收起分支", "chevron", event => { event.stopPropagation(); toggle(); });
          collapse.classList.add("summary-map-collapse");
          collapse.dataset.collapsed = String(collapsed.has(node.data.id));
          foreign.appendChild(collapse);
          g.appendChild(foreign);
        }
        scene.appendChild(g);
      }
      const top = Math.min(...nodes.map(n => n.x - n.boxHeight / 2));
      const bottom = Math.max(...nodes.map(n => n.x + n.boxHeight / 2));
      bounds = { left: 0, top, width: Math.max(...nodes.map(n => n.y + 224)), height: bottom - top };
      applyTransform();
    }
    let drag = null;
    svg.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(".summary-map-node")) return;
      autoFit = false;
      drag = { x: event.clientX, y: event.clientY, startX: transform.x, startY: transform.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", event => {
      if (!drag) return;
      transform.x = drag.startX + event.clientX - drag.x;
      transform.y = drag.startY + event.clientY - drag.y;
      applyTransform();
    });
    const endDrag = () => { drag = null; };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
    svg.addEventListener("lostpointercapture", endDrag);
    svg.addEventListener("wheel", event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.005), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    const observer = new win.ResizeObserver(() => { if (autoFit) fit(); });
    observer.observe(canvas);
    draw();
    zoomTimer = win.requestAnimationFrame(fit);
    const controller = { element, fit, destroy() {
      alive = false;
      playbackRequest++;
      observer.disconnect();
      win.cancelAnimationFrame(zoomTimer);
      audio?.pause();
      if (audio) { audio.removeAttribute("src"); audio.load(); }
    }, pause() { playbackRequest++; audio?.pause(); } };
    mounts.set(container, { signature, controller });
    return controller;
  }

  const api = { render, dispose, timestamp };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SummaryReader = api;
})(typeof window === "undefined" ? null : window);
