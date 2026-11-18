/**
 * Harness Gemini UI - Markdown/KaTeX Rendering, Structured Web/Tool Cards,
 * Subagent Progress, Artifact Previews & Message Stream Items
 * License: MIT
 */

import {
  React,
  jsx,
  jsxs,
  Fragment,
  ReactMarkdown,
  remarkGfm,
  remarkMath,
  rehypeKatex,
  ArrowDownToLine,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Copy,
  Earth,
  Expand,
  ExternalLink,
  File,
  FileArchive,
  FileCodeCorner,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  ImageOff,
  ImagePlus,
  Info,
  Link2,
  ListChecks,
  LoaderCircle,
  Minimize2,
  MousePointerClick,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareTerminal,
  X,
  Zap,
} from '../vendor/vendor-deps.js';
import { createReplyUI, localImageUrl } from '../modules/reply-ui.js';
import { createBranchUI } from '../modules/branch-ui.js';
import {
  artifactDownloadUrl,
  attachmentPreviewUrl,
  basenameOrWorkspace,
  classifyAttachmentKind,
  copyImageToClipboard,
  formatBytes,
  formatClockTime,
  safeMarkdownUrlTransform,
  sanitizeImageSrc,
  stringifyToolValue,
  workspaceRelativeImageUrl,
} from './api.js';

/* -------------------------------------------------------------------------- */
/* Custom Harness Math Remark/Rehype Extensions ($...$, \(...\), \[...\])     */
/* -------------------------------------------------------------------------- */

const CODE_DOLLAR = 36;
const CODE_BACKSLASH = 92;

const isLineEndingCode = (code) => code !== null && code <= -3;
const isWhitespaceCode = (code) =>
  code !== null && (code < 0 || /\s/u.test(String.fromCodePoint(code)));
const isAsciiDigitCode = (code) => code !== null && code >= 48 && code <= 57;

function tokenizeHarnessDollarMath(effects, ok, nok) {
  let prevCode;
  let length = 0;
  let startsWithDigit = false;
  let hasMathSymbol = false;

  return start;

  function start(code) {
    const token = effects.enter('harnessMath');
    token.harnessMarkerLength = 1;
    effects.consume(code);
    return afterOpen;
  }

  function afterOpen(code) {
    if (code === null || code === CODE_DOLLAR || isWhitespaceCode(code)) {
      return nok(code);
    }
    startsWithDigit = isAsciiDigitCode(code);
    return inside(code);
  }

  function inside(code) {
    if (code === null || isLineEndingCode(code) || ++length > 20_000) {
      return nok(code);
    }
    if (code === CODE_DOLLAR) {
      if (isWhitespaceCode(prevCode)) return nok(code);
      return effects.check({ tokenize: checkAfterClosingDollar }, close, nok)(code);
    }
    if (code >= 0) {
      const ch = String.fromCodePoint(code);
      if (startsWithDigit && !hasMathSymbol && /\p{Script=Han}/u.test(ch)) {
        return nok(code);
      }
      if (/[\\^_+*/=<>|{}-]|\p{Sm}/u.test(ch)) {
        hasMathSymbol = true;
      }
    }
    prevCode = code;
    effects.consume(code);
    return code === CODE_BACKSLASH ? escaped : inside;
  }

  function escaped(code) {
    if (code === null || isLineEndingCode(code)) return nok(code);
    prevCode = code;
    effects.consume(code);
    return inside;
  }

  function close(code) {
    effects.consume(code);
    effects.exit('harnessMath');
    return ok;
  }
}

function checkAfterClosingDollar(effects, ok, nok) {
  return first;

  function first(code) {
    effects.consume(code);
    return after;
  }

  function after(code) {
    return code === CODE_DOLLAR || isAsciiDigitCode(code) ? nok(code) : ok(code);
  }
}

function tokenizeHarnessBracketMath(effects, ok, nok) {
  let mathToken;
  let expectedCloseCode;
  let length = 0;
  let inData = false;

  return start;

  function start(code) {
    mathToken = effects.enter('harnessMath');
    mathToken.harnessMarkerLength = 2;
    effects.enter('harnessMathMarker');
    effects.consume(code);
    return openDelimiter;
  }

  function openDelimiter(code) {
    if (code !== 40 && code !== 91) return nok(code);
    expectedCloseCode = code === 40 ? 41 : 93;
    mathToken.harnessDisplay = code === 91;
    effects.consume(code);
    effects.exit('harnessMathMarker');
    return inside;
  }

  function inside(code) {
    if (code === null || ++length > 20_000 || (!mathToken.harnessDisplay && isLineEndingCode(code))) {
      return nok(code);
    }
    consumeContent(code);
    return code === CODE_BACKSLASH ? afterBackslash : inside;
  }

  function afterBackslash(code) {
    if (code === null || (!mathToken.harnessDisplay && isLineEndingCode(code))) {
      return nok(code);
    }
    consumeContent(code);
    if (code === expectedCloseCode) {
      closeDataIfOpen();
      effects.exit('harnessMath');
      return ok;
    }
    return inside;
  }

  function consumeContent(code) {
    if (isLineEndingCode(code)) {
      closeDataIfOpen();
      effects.enter('harnessMathLineEnding');
      effects.consume(code);
      effects.exit('harnessMathLineEnding');
    } else {
      if (!inData) {
        effects.enter('harnessMathData');
        inData = true;
      }
      effects.consume(code);
    }
  }

  function closeDataIfOpen() {
    if (inData) {
      effects.exit('harnessMathData');
      inData = false;
    }
  }
}

function remarkHarnessMath() {
  const data = this.data();
  (data.micromarkExtensions ||= []).push({
    text: {
      [CODE_DOLLAR]: {
        name: 'harnessDollarMath',
        tokenize: tokenizeHarnessDollarMath,
        previous(code) {
          return code !== CODE_DOLLAR || this.events.at(-1)?.[1].type === 'characterEscape';
        },
      },
      [CODE_BACKSLASH]: {
        name: 'harnessBracketMath',
        tokenize: tokenizeHarnessBracketMath,
      },
    },
  });

  (data.fromMarkdownExtensions ||= []).push({
    enter: {
      harnessMath(token) {
        this.enter({ type: 'inlineMath', value: '' }, token);
      },
    },
    exit: {
      harnessMath(token) {
        const node = this.stack.at(-1);
        node.value = this.sliceSerialize(token).slice(
          token.harnessMarkerLength,
          -token.harnessMarkerLength,
        );
        node.data = {
          hName: 'code',
          hProperties: {
            className: ['language-math', token.harnessDisplay ? 'math-display' : 'math-inline'],
          },
          hChildren: [{ type: 'text', value: node.value }],
        };
        this.exit(token);
      },
    },
  });
}

function walkHastTree(node, visitor) {
  visitor(node);
  node.children?.forEach((child) => walkHastTree(child, visitor));
}

function measureHastTextLength(node) {
  if (typeof node.value === 'string') return node.value.length;
  return (node.children || []).reduce((acc, child) => acc + measureHastTextLength(child), 0);
}

function rehypeSafeKatex() {
  const transformKatex = rehypeKatex({
    trust: false,
    strict: 'ignore',
    maxSize: 20,
    maxExpand: 1000,
  });

  return (tree, file) => {
    const bypassed = [];
    walkHastTree(tree, (node) => {
      if (node.type !== 'element' || node.tagName !== 'code') return;
      const classes = node.properties?.className;
      if (!Array.isArray(classes)) return;
      const isExplicitMath = classes.includes('math-inline') || classes.includes('math-display');
      if (
        (!isExplicitMath && classes.includes('language-math')) ||
        (isExplicitMath && measureHastTextLength(node) > 20_000)
      ) {
        bypassed.push([node, classes]);
        node.properties.className = classes.filter(
          (cls) => !['language-math', 'math-inline', 'math-display'].includes(cls),
        );
      }
    });

    try {
      transformKatex(tree, file);
    } finally {
      for (const [node, originalClasses] of bypassed) {
        node.properties.className = originalClasses;
      }
    }
  };
}

export const REMARK_PLUGINS = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkHarnessMath,
];

export const REHYPE_PLUGINS = [rehypeSafeKatex];

/* -------------------------------------------------------------------------- */
/* Structured Web / Browser / Download Tool Result Cards                      */
/* -------------------------------------------------------------------------- */

const STRUCTURED_WEB_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'download_file',
  'browser_open',
  'browser_navigate',
  'browser_page_content',
  'browser_snapshot',
  'browser_act',
]);

const PAGE_CONTENT_TOOLS = new Set(['fetch_url', 'browser_navigate', 'browser_page_content']);

function sanitizeHttpLink(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) || trimmed.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(trimmed)) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return '';
    }
    return parsed.href;
  } catch {
    return '';
  }
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function isPlainRecord(value) {
  return typeof value === 'object' && Boolean(value) && !Array.isArray(value);
}

export function parseStructuredToolResult(toolName, rawOutput) {
  if (!STRUCTURED_WEB_TOOLS.has(toolName)) return null;
  let payload;
  try {
    payload = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return null;
  }
  if (!isPlainRecord(payload) || payload.error) return null;

  if (toolName === 'web_search') {
    if (!Array.isArray(payload.results)) return null;
    const results = payload.results
      .filter(isPlainRecord)
      .slice(0, 50)
      .map((entry) => ({
        title: asString(entry.title),
        url: sanitizeHttpLink(entry.url),
        snippet: asString(entry.snippet),
      }));
    return {
      type: 'search',
      query: asString(payload.query),
      provider: asString(payload.provider),
      results,
      limited: payload.results.length > 50,
    };
  }

  if (toolName === 'browser_snapshot') {
    if (!isPlainRecord(payload.viewport) || !Array.isArray(payload.elements)) return null;
    const elements = payload.elements
      .filter(isPlainRecord)
      .slice(0, 120)
      .map((el) => ({
        ref: asString(el.ref),
        role: asString(el.role),
        name: asString(el.name),
        disabled: el.disabled === true,
        checked: el.checked === true || (el.checked !== false && null),
        type: asString(el.type),
        value: asString(el.value),
      }))
      .filter((el) => el.ref);
    return {
      type: 'snapshot',
      url: sanitizeHttpLink(payload.url),
      title: asString(payload.title),
      count: elements.length,
      truncated: payload.truncated === true,
      elements,
      note: asString(payload.note),
    };
  }

  if (toolName === 'browser_act') {
    const action = asString(payload.action);
    if (!action) return null;
    return {
      type: 'action',
      url: sanitizeHttpLink(payload.url),
      action,
      target: isPlainRecord(payload.target)
        ? { role: asString(payload.target.role), name: asString(payload.target.name) }
        : null,
      characters: Number.isFinite(payload.characters) ? payload.characters : 0,
      submitted: payload.submitted === true,
      replacedExistingText: payload.replacedExistingText === true,
      keys: Array.isArray(payload.keys)
        ? payload.keys.map((k) => asString(k)).filter(Boolean).slice(0, 4)
        : [],
      direction: asString(payload.direction),
      amount: Number.isFinite(payload.amount) ? payload.amount : null,
      scrollY: Number.isFinite(payload.scrollY) ? payload.scrollY : null,
      steps: Number.isFinite(payload.steps) ? payload.steps : 0,
      stillPresent: payload.stillPresent === true,
      moved: payload.moved === true,
      note: asString(payload.note),
    };
  }

  if (PAGE_CONTENT_TOOLS.has(toolName) || toolName === 'browser_open') {
    if (PAGE_CONTENT_TOOLS.has(toolName) && typeof payload.content !== 'string') return null;
    const links = Array.isArray(payload.links)
      ? payload.links
          .filter(isPlainRecord)
          .map((link) => ({
            title: asString(link.title) || asString(link.text),
            url: sanitizeHttpLink(link.url),
          }))
          .filter((link) => link.url)
          .slice(0, 20)
      : [];
    return {
      type: 'page',
      url: sanitizeHttpLink(payload.url),
      title: asString(payload.title),
      content: typeof payload.content === 'string' ? payload.content : '',
      truncated: payload.truncated === true,
      contentType:
        asString(payload.contentType) || (toolName.startsWith('browser_') ? 'text/html' : ''),
      note: asString(payload.note),
      links,
    };
  }

  if (
    payload.downloaded !== true ||
    !asString(payload.path) ||
    !Number.isFinite(payload.bytes) ||
    payload.bytes < 0
  ) {
    return null;
  }
  return {
    type: 'download',
    path: payload.path,
    fileName: asString(payload.fileName),
    bytes: payload.bytes,
    sha256: asString(payload.sha256),
    url: sanitizeHttpLink(payload.url),
    contentType: asString(payload.contentType),
  };
}

function normalizeDownloadProgress(progress) {
  if (!isPlainRecord(progress) || !Number.isFinite(progress.bytes) || progress.bytes < 0) {
    return null;
  }
  const bytes = progress.bytes;
  const totalBytes =
    Number.isFinite(progress.totalBytes) && progress.totalBytes > 0 ? progress.totalBytes : null;
  return {
    bytes,
    totalBytes,
    percent: totalBytes ? Math.min(100, Math.max(0, (bytes / totalBytes) * 100)) : null,
  };
}

function getUrlHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function WebSourceLink({ url, children, className = '' }) {
  if (url) {
    return jsxs('a', {
      className: `web-source-link ${className}`,
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: url,
      children: [children || getUrlHostname(url), jsx(ExternalLink, { size: 11 })],
    });
  }
  return jsx('span', {
    className: `web-link-unavailable ${className}`,
    children: children || '来源链接不可用',
  });
}

function WebSearchResultsCard({ result }) {
  const [expanded, setExpanded] = React.useState(false);
  const visibleResults = expanded ? result.results : result.results.slice(0, 3);

  return jsxs('div', {
    className: 'web-search-results',
    children: [
      jsxs('div', {
        className: 'web-result-caption',
        children: [
          jsxs('span', {
            children: [
              jsx(Search, { size: 12 }),
              result.results.length ? `${result.results.length} 条结果` : '搜索完成',
            ],
          }),
          result.provider && jsx('span', { title: result.provider, children: result.provider }),
        ],
      }),
      result.query && jsx('div', { className: 'web-search-query', children: result.query }),
      visibleResults.length
        ? jsx('ol', {
            className: 'web-search-list',
            children: visibleResults.map((entry, index) =>
              jsxs(
                'li',
                {
                  children: [
                    jsx('span', { className: 'web-result-number', children: index + 1 }),
                    jsxs('div', {
                      children: [
                        jsx(WebSourceLink, {
                          url: entry.url,
                          className: 'web-result-title',
                          children: entry.title || getUrlHostname(entry.url) || '未命名结果',
                        }),
                        entry.snippet && jsx('p', { children: entry.snippet }),
                        entry.url
                          ? jsx(WebSourceLink, {
                              url: entry.url,
                              className: 'web-result-origin',
                              children: getUrlHostname(entry.url),
                            })
                          : jsx('span', {
                              className: 'web-link-unavailable',
                              children: '来源链接不可用',
                            }),
                      ],
                    }),
                  ],
                },
                index,
              ),
            ),
          })
        : jsx('div', {
            className: 'web-results-empty',
            children: '没有找到匹配的网页，可以换一组关键词再试。',
          }),
      result.results.length > 3 &&
        jsxs('button', {
          type: 'button',
          className: 'text-button web-results-toggle',
          onClick: () => setExpanded((prev) => !prev),
          'aria-expanded': expanded,
          children: [
            jsx(ChevronDown, { size: 12, className: expanded ? 'rotated' : '' }),
            expanded ? '收起更多结果' : `查看其余 ${result.results.length - 3} 条结果`,
          ],
        }),
      result.limited &&
        jsx('div', {
          className: 'web-content-note',
          children: '此处最多展示前 50 条结果。',
        }),
    ],
  });
}

function WebPageContentCard({ result }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = result.content.length > 1200;
  const snippet = expanded ? result.content : result.content.slice(0, 1200);

  return jsxs('div', {
    className: 'web-page-result',
    children: [
      jsxs('div', {
        className: 'web-page-heading',
        children: [
          jsx(Earth, { size: 16 }),
          jsxs('div', {
            children: [
              jsx('strong', {
                children: result.title || getUrlHostname(result.url) || '网页内容',
              }),
              jsx(WebSourceLink, { url: result.url }),
            ],
          }),
        ],
      }),
      result.content
        ? jsxs('div', {
            className: `web-page-content${expanded ? ' expanded' : ''}`,
            children: [snippet, isLong && !expanded && '…'],
          })
        : jsx('div', {
            className: 'web-results-empty',
            children: result.note || '网页没有返回可读取的正文。',
          }),
      isLong &&
        jsxs('button', {
          type: 'button',
          className: 'text-button web-results-toggle',
          onClick: () => setExpanded((prev) => !prev),
          'aria-expanded': expanded,
          children: [jsx(FileText, { size: 12 }), expanded ? '收起正文' : '展开已读取正文'],
        }),
      result.truncated &&
        jsx('div', {
          className: 'web-content-note',
          children: '网页较长，本次读取了部分内容。',
        }),
      result.links.length > 0 &&
        jsxs('details', {
          className: 'web-page-links',
          children: [
            jsxs('summary', {
              children: [jsx(Link2, { size: 12 }), '网页中的链接 · ', result.links.length],
            }),
            jsx('div', {
              children: result.links.map((link, idx) =>
                jsx(
                  WebSourceLink,
                  {
                    url: link.url,
                    children: link.title || getUrlHostname(link.url),
                  },
                  idx,
                ),
              ),
            }),
          ],
        }),
    ],
  });
}

function DownloadResultCard({ result, onToast }) {
  const [copied, setCopied] = React.useState(false);
  const displayName = result.fileName || basenameOrWorkspace(result.path);

  return jsxs('div', {
    className: 'download-result',
    children: [
      jsxs('div', {
        className: 'download-result-heading',
        children: [
          jsx('span', {
            className: 'download-file-icon',
            children: jsx(ArrowDownToLine, { size: 16 }),
          }),
          jsxs('div', {
            children: [
              jsx('strong', { title: displayName, children: displayName }),
              jsxs('span', {
                children: [jsx(Check, { size: 11 }), '已保存 · ', formatBytes(result.bytes)],
              }),
            ],
          }),
        ],
      }),
      jsxs('div', {
        className: 'download-path-row',
        children: [
          jsx('code', { children: result.path }),
          jsx('button', {
            type: 'button',
            className: 'icon-button small',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(result.path);
                setCopied(true);
                onToast?.('下载路径已复制');
              } catch {
                setCopied(false);
                onToast?.('复制失败，请手动选中路径复制', 'error');
              }
            },
            title: '复制下载路径',
            'aria-label': '复制下载路径',
            children: copied ? jsx(Check, { size: 14 }) : jsx(Copy, { size: 14 }),
          }),
        ],
      }),
      jsxs('div', {
        className: 'download-result-meta',
        children: [
          jsxs('span', {
            children: [Math.floor(result.bytes).toLocaleString('en-US'), ' 字节'],
          }),
          jsx(WebSourceLink, { url: result.url, children: '查看来源' }),
        ],
      }),
    ],
  });
}

function DownloadProgressBar({ progress, interrupted = false }) {
  const info = normalizeDownloadProgress(progress);
  if (!info) return null;
  const roundedPercent = info.percent === null ? null : Math.floor(info.percent);
  const sizeText =
    formatBytes(info.bytes) + (info.totalBytes ? ` / ${formatBytes(info.totalBytes)}` : '');

  return jsxs('div', {
    className: `download-progress${interrupted ? ' interrupted' : ''}`,
    children: [
      jsxs('div', {
        className: 'download-progress-label',
        children: [
          jsxs('span', {
            children: [
              interrupted ? '已停止接收' : info.percent === 100 ? '已接收，正在保存' : '正在下载',
              ' · ',
              sizeText,
            ],
          }),
          roundedPercent !== null && jsxs('span', { children: [roundedPercent, '%'] }),
        ],
      }),
      jsx('div', {
        className: `download-progress-track${roundedPercent === null ? ' indeterminate' : ''}`,
        role: 'progressbar',
        'aria-label': '文件下载进度',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': roundedPercent ?? undefined,
        'aria-valuetext': `${interrupted ? '已停止，' : ''}已接收 ${sizeText}`,
        children: jsx('span', {
          style: roundedPercent === null ? undefined : { width: `${info.percent}%` },
        }),
      }),
    ],
  });
}

function BrowserSnapshotCard({ result }) {
  const [expanded, setExpanded] = React.useState(false);
  const visibleElements = expanded ? result.elements : result.elements.slice(0, 6);

  return jsxs('div', {
    className: 'web-page-result',
    children: [
      jsxs('div', {
        className: 'web-page-heading',
        children: [
          jsx(Earth, { size: 16 }),
          jsxs('div', {
            children: [
              jsx('strong', {
                children: result.title || getUrlHostname(result.url) || '页面元素',
              }),
              jsx(WebSourceLink, { url: result.url }),
            ],
          }),
        ],
      }),
      result.elements.length
        ? jsx('ol', {
            className: 'browser-element-list',
            children: visibleElements.map((el) =>
              jsxs(
                'li',
                {
                  children: [
                    jsx('code', { children: el.ref }),
                    jsxs('span', {
                      children: [
                        el.role || 'element',
                        el.name ? ` · ${el.name}` : '',
                        el.disabled ? ' · 已禁用' : '',
                        el.checked === true ? ' · 已选中' : '',
                        el.checked === false ? ' · 未选中' : '',
                      ],
                    }),
                  ],
                },
                el.ref,
              ),
            ),
          })
        : jsx('div', {
            className: 'web-results-empty',
            children: result.note || '没有检测到可交互元素。',
          }),
      result.elements.length > 6 &&
        jsxs('button', {
          type: 'button',
          className: 'text-button web-results-toggle',
          onClick: () => setExpanded((prev) => !prev),
          'aria-expanded': expanded,
          children: [
            jsx(ChevronDown, { size: 12, className: expanded ? 'rotated' : '' }),
            expanded ? '收起元素列表' : `查看其余 ${result.elements.length - 6} 个元素`,
          ],
        }),
      result.truncated &&
        jsxs('div', {
          className: 'web-content-note',
          children: ['元素较多，只读取了前 ', result.count, ' 个。'],
        }),
    ],
  });
}

const BROWSER_ACTION_LABELS = {
  click: '点击',
  type: '输入文字',
  press: '按键',
  scroll: '滚动页面',
  drag: '拖拽',
};

function BrowserActionCard({ result }) {
  const targetLabel = result.target?.name || result.target?.role || '';
  const detailText =
    result.action === 'type'
      ? `已输入 ${result.characters} 个字符${result.submitted ? '，并已提交' : ''}`
      : result.action === 'press'
        ? `按键 ${result.keys.join('、') || ''}`
        : result.action === 'scroll'
          ? `滚动${result.direction ? `（${result.direction}）` : ''}${result.scrollY === null ? '' : ` · 当前位置 ${result.scrollY}`}`
          : result.action === 'drag'
            ? `拖拽 ${result.steps} 步`
            : result.moved
              ? '元素位置已变化'
              : '已发送点击';

  return jsxs('div', {
    className: 'web-page-result',
    children: [
      jsxs('div', {
        className: 'web-page-heading',
        children: [
          jsx(MousePointerClick, { size: 16 }),
          jsxs('div', {
            children: [
              jsxs('strong', {
                children: [
                  BROWSER_ACTION_LABELS[result.action] || result.action,
                  targetLabel ? ` · ${targetLabel}` : '',
                ],
              }),
              jsx(WebSourceLink, { url: result.url }),
            ],
          }),
        ],
      }),
      jsx('div', { className: 'web-content-note', children: detailText }),
      result.note && jsx('div', { className: 'web-content-note', children: result.note }),
    ],
  });
}

function StructuredToolResultView({ result, onToast }) {
  if (result.type === 'search') return jsx(WebSearchResultsCard, { result });
  if (result.type === 'snapshot') return jsx(BrowserSnapshotCard, { result });
  if (result.type === 'action') return jsx(BrowserActionCard, { result });
  if (result.type === 'page') return jsx(WebPageContentCard, { result });
  if (result.type === 'download') return jsx(DownloadResultCard, { result, onToast });
  return null;
}

/* -------------------------------------------------------------------------- */
/* Subagent Cards & Tool Execution Timeline                                   */
/* -------------------------------------------------------------------------- */

function formatSubagentSpeed(metrics) {
  if (!metrics) return '';
  const tps = metrics.tokensPerSecond;
  if (!Number.isFinite(tps) || metrics.source === 'none') return '';
  const prefix = metrics.source === 'estimated' ? '≈ ' : '';
  const num = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(tps);
  return `${prefix}${num} tokens/s`;
}

function formatSubagentDuration(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '—';
  const sec = elapsedMs / 1000;
  return sec < 60
    ? `${sec.toFixed(1)}秒`
    : `${Math.floor(sec / 60)}分 ${Math.floor(sec % 60)}秒`;
}

export function extractSubagentEntries(messages = []) {
  const entries = [];
  for (const msg of messages) {
    if (msg?.role === 'assistant') {
      for (const tool of msg.tools || []) {
        if (tool?.name === 'spawn_subagent') {
          entries.push({
            id: tool.id,
            messageId: msg.id,
            createdAt: msg.createdAt || '',
            label:
              tool.subagent?.label ||
              String(tool.args?.prompt || '').split(/\r?\n/)[0].slice(0, 80) ||
              '子代理',
            status: tool.subagent?.status || tool.status || 'running',
            subagent: tool.subagent || null,
            active: msg.status === 'running',
          });
        }
      }
    }
  }
  return entries.reverse();
}

export function countRunningSubagents(entries = []) {
  return entries.filter((entry) => entry.status === 'running').length;
}

export const TOOL_DISPLAY_NAMES = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  list_files: '查看目录',
  list_directory: '查看目录',
  search_files: '搜索文件',
  search_text: '搜索内容',
  run_command: '执行命令',
  run_shell: '执行命令',
  shell: '执行命令',
  execute_command: '执行命令',
  generate_image: '生成图片',
  web_search: '搜索网页',
  fetch_url: '读取网页',
  download_file: '下载文件',
  browser_open: '在内置浏览器打开',
  browser_navigate: '内置浏览器读取',
  browser_page_content: '读取浏览器当前页',
  browser_snapshot: '读取页面元素',
  browser_act: '操作浏览器页面',
  spawn_subagent: '子代理',
};

function getSubagentStatusLabel(subagent) {
  if (!subagent) return '子代理';
  if (subagent.status === 'running') return '子代理工作中';
  if (subagent.status === 'done') return '子代理已交付结论';
  if (subagent.status === 'cancelled') return '子代理已停止';
  return '子代理未完成';
}

function tailReasoningText(text, maxLen = 2000) {
  const trimmed = String(text || '').trim();
  return trimmed.length > maxLen ? `…${trimmed.slice(-maxLen)}` : trimmed;
}

function SubagentStepItem({ step }) {
  return jsxs('li', {
    className: step.status,
    children: [
      jsx('span', {
        className: 'subagent-step-name',
        children: TOOL_DISPLAY_NAMES[step.name] || step.name,
      }),
      jsx('span', {
        className: 'subagent-step-detail',
        children:
          step.args?.path || step.args?.command || step.args?.query || step.args?.url || '',
      }),
      jsx('span', {
        className: `subagent-step-state ${step.status}`,
        children:
          step.status === 'running'
            ? jsx(LoaderCircle, { size: 11, className: 'spin' })
            : step.status === 'done'
              ? jsx(Check, { size: 11 })
              : step.status === 'pending'
                ? jsx(ShieldCheck, { size: 11 })
                : jsx(X, { size: 11 }),
      }),
    ],
  });
}

export function SubagentCard({ subagent, entry }) {
  const [expanded, setExpanded] = React.useState(true);
  const [reasoningOpenState, setReasoningOpenState] = React.useState(null);
  const steps = subagent?.steps ?? [];
  const isRunning = subagent?.status === 'running';
  const reasoningTail = tailReasoningText(subagent?.reasoning);
  const reasoningOpen = reasoningOpenState ?? false;
  const label = subagent?.label || entry?.label || '子代理';
  const speedText = formatSubagentSpeed(subagent?.metrics);
  const bodyId = React.useId();
  const stateTone =
    subagent?.status === 'done'
      ? 'done'
      : subagent?.status === 'cancelled'
        ? 'cancelled'
        : subagent?.status === 'error'
          ? 'error'
          : 'running';

  return jsxs('section', {
    className: `subagent-card ${stateTone}`,
    'aria-label': `子代理：${label}`,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'subagent-card-heading',
        onClick: () => setExpanded((prev) => !prev),
        'aria-expanded': expanded,
        'aria-controls': bodyId,
        children: [
          jsx('span', { className: 'subagent-card-icon', children: jsx(Bot, { size: 15 }) }),
          jsxs('span', {
            className: 'subagent-card-title',
            children: [
              jsx('strong', { title: label, children: label }),
              jsxs('span', {
                className: 'subagent-card-sub',
                children: [
                  jsxs('span', {
                    className: `subagent-state ${stateTone}`,
                    children: [
                      isRunning
                        ? jsx(LoaderCircle, { size: 11, className: 'spin' })
                        : subagent?.status === 'done'
                          ? jsx(Check, { size: 11 })
                          : jsx(X, { size: 11 }),
                      getSubagentStatusLabel(subagent),
                    ],
                  }),
                  subagent?.rounds > 0 &&
                    jsxs('span', {
                      className: 'subagent-rounds',
                      children: [subagent.rounds, ' 轮'],
                    }),
                  steps.length > 0 &&
                    jsxs('span', {
                      className: 'subagent-rounds',
                      children: [steps.length, ' 次工具'],
                    }),
                  speedText &&
                    jsx('span', {
                      className: 'subagent-rounds',
                      title: '本子代理自己的输出速度，不计入主对话的速度',
                      children: speedText,
                    }),
                ],
              }),
            ],
          }),
          expanded ? jsx(ChevronDown, { size: 14 }) : jsx(ChevronRight, { size: 14 }),
        ],
      }),
      expanded &&
        jsxs('div', {
          className: 'subagent-body',
          id: bodyId,
          children: [
            reasoningTail &&
              jsxs('div', {
                className: `subagent-reasoning ${isRunning ? 'live' : ''} ${reasoningOpen ? 'open' : ''}`,
                children: [
                  jsxs('button', {
                    type: 'button',
                    className: 'subagent-reasoning-label',
                    onClick: () => setReasoningOpenState(!reasoningOpen),
                    'aria-expanded': reasoningOpen,
                    children: [
                      isRunning
                        ? jsx(LoaderCircle, { size: 11, className: 'spin' })
                        : jsx(Bot, { size: 11 }),
                      isRunning ? '子代理正在思考' : '子代理思考过程',
                      jsx(ChevronDown, { size: 11, className: 'subagent-reasoning-chevron' }),
                    ],
                  }),
                  reasoningOpen && jsx('pre', { children: reasoningTail }),
                ],
              }),
            steps.length > 0 &&
              jsx('ol', {
                className: 'subagent-steps',
                children: steps.map((step) => jsx(SubagentStepItem, { step }, step.id)),
              }),
            subagent?.error && jsx('p', { className: 'subagent-error', children: subagent.error }),
            subagent?.text &&
              jsxs('div', {
                className: 'subagent-answer',
                children: [
                  jsx('span', { className: 'detail-label', children: '子代理结论' }),
                  jsx('pre', {
                    children:
                      subagent.text.length > 6000
                        ? `${subagent.text.slice(0, 6000)}\n… 结论较长，此处显示部分内容`
                        : subagent.text,
                  }),
                ],
              }),
            !steps.length &&
              !subagent?.text &&
              !reasoningTail &&
              !subagent?.error &&
              jsx('p', {
                className: 'subagent-waiting',
                children: isRunning
                  ? '子代理正在读取任务说明，还没有产生输出。'
                  : '这个子代理没有产生可显示的内容。',
              }),
            subagent?.metrics &&
              jsxs('div', {
                className: 'subagent-footer',
                children: [
                  jsxs('span', { children: [subagent.metrics.requests, ' 次模型请求'] }),
                  jsxs('span', {
                    children: [formatSubagentDuration(subagent.metrics.elapsedMs), ' 模型耗时'],
                  }),
                  subagent.metrics.outputTokens > 0 &&
                    jsxs('span', {
                      children: [
                        subagent.metrics.source === 'usage' ? '' : '≈ ',
                        Math.round(subagent.metrics.outputTokens).toLocaleString('en-US'),
                        ' token',
                      ],
                    }),
                ],
              }),
          ],
        }),
    ],
  });
}

function summarizeStructuredResult(parsed) {
  if (parsed?.type === 'search') return `共 ${parsed.results.length} 条结果`;
  if (parsed?.type === 'page') return parsed.title || '已读取网页正文';
  if (parsed?.type === 'download') return `已保存 · ${formatBytes(parsed.bytes)}`;
  if (parsed?.type === 'snapshot') return `${parsed.count} 个可交互元素`;
  if (parsed?.type === 'action') return '已执行';
  return '';
}

export function ToolCallCard({
  tool,
  approval,
  decision,
  approving,
  onApprove,
  onToast,
  active = false,
  timeline = false,
}) {
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();

  const isAborted = !active && ['pending', 'running'].includes(tool.status);
  const isPending = tool.status === 'pending' && !isAborted;
  const isRunning = tool.status === 'running' && !isAborted;
  const isFailed = tool.status === 'error' || isAborted;

  const statusText = isAborted
    ? '已中断'
    : isPending
      ? decision
        ? decision === 'approved'
          ? '已批准，等待执行'
          : '已拒绝'
        : '等待确认'
      : isRunning
        ? '执行中'
        : isFailed
          ? '执行未完成'
          : '已完成';

  const isExternalSkill = /^ext_/.test(tool.name || '');
  const displayName =
    TOOL_DISPLAY_NAMES[tool.name] ||
    (isExternalSkill ? `外置技能 · ${tool.name.slice(4)}` : tool.name) ||
    '工具操作';

  const ToolIcon = isExternalSkill
    ? Puzzle
    : tool.name === 'spawn_subagent'
      ? Bot
      : tool.name === 'generate_image'
        ? ImagePlus
        : tool.name === 'web_search'
          ? Search
          : tool.name === 'fetch_url'
            ? Earth
            : tool.name === 'download_file'
              ? ArrowDownToLine
              : /^browser_/.test(tool.name || '')
                ? Earth
                : /command|shell|terminal|bash/.test(tool.name || '')
                  ? SquareTerminal
                  : /search|list/.test(tool.name || '')
                    ? FolderSearch
                    : FileCodeCorner;

  const args = tool.args || approval?.args || {};
  const argPreview =
    tool.name === 'spawn_subagent'
      ? tool.subagent?.label || String(args.prompt || '').split(/\r?\n/)[0].slice(0, 120)
      : args.command ||
        args.path ||
        args.query ||
        args.url ||
        (args.action
          ? `${args.action}${args.ref ? ` ${args.ref}` : ''}${args.text ? ` ${String(args.text).slice(0, 60)}` : ''}`
          : '');

  const primarySummary = (isPending && !decision && approval?.summary) || argPreview;
  const rawOutputText = stringifyToolValue(tool.output);
  const structuredResult = React.useMemo(
    () => parseStructuredToolResult(tool.name, tool.output),
    [tool.name, tool.output],
  );
  const resultCaption = tool.status === 'done' ? summarizeStructuredResult(structuredResult) : '';
  const approvalId = tool.approvalId || approval?.id;
  const subagentHint = tool.name === 'spawn_subagent' ? '详情在工作空间 · 子代理' : '';

  return jsxs('div', {
    className: `tool-card ${timeline ? 'tool-timeline-card' : ''} ${isPending && !decision ? 'needs-approval' : ''} ${isFailed ? 'failed' : ''}`,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'tool-card-heading',
        onClick: () => setExpanded((prev) => !prev),
        'aria-expanded': expanded,
        'aria-controls': detailsId,
        children: [
          jsx('span', { className: 'tool-icon', children: jsx(ToolIcon, { size: 16 }) }),
          jsxs('span', {
            className: 'tool-heading-text',
            children: [
              jsx('strong', { children: displayName }),
              primarySummary &&
                jsx('span', {
                  title: String(primarySummary),
                  children: String(primarySummary),
                }),
              resultCaption &&
                jsx('span', { className: 'tool-result-caption', children: resultCaption }),
              subagentHint &&
                jsx('span', { className: 'tool-result-caption', children: subagentHint }),
            ],
          }),
          jsxs('span', {
            className: `tool-state ${isPending ? 'pending' : isFailed ? 'error' : isRunning ? 'running' : 'done'}`,
            children: [
              isRunning
                ? jsx(LoaderCircle, { size: 12, className: 'spin' })
                : isPending
                  ? jsx(ShieldCheck, { size: 12 })
                  : isFailed
                    ? jsx(X, { size: 12 })
                    : jsx(Check, { size: 12 }),
              statusText,
            ],
          }),
          expanded ? jsx(ChevronDown, { size: 14 }) : jsx(ChevronRight, { size: 14 }),
        ],
      }),
      tool.name === 'download_file' &&
        tool.status !== 'done' &&
        tool.progress &&
        jsx(DownloadProgressBar, {
          progress: tool.progress,
          interrupted: isFailed || !isRunning,
        }),
      jsx('div', {
        id: detailsId,
        className: 'tool-expandable-details',
        hidden: !expanded,
        children:
          expanded &&
          jsxs(Fragment, {
            children: [
              tool.status === 'done' &&
                structuredResult &&
                jsx(StructuredToolResultView, { result: structuredResult, onToast }),
              jsxs('div', {
                className: 'tool-details',
                children: [
                  Object.keys(args).length > 0 &&
                    jsxs(Fragment, {
                      children: [
                        jsx('span', {
                          className: 'detail-label',
                          children: tool.name === 'spawn_subagent' ? '任务说明' : '操作内容',
                        }),
                        jsx('pre', { children: stringifyToolValue(args) }),
                      ],
                    }),
                  rawOutputText &&
                    !structuredResult &&
                    jsxs(Fragment, {
                      children: [
                        jsx('span', { className: 'detail-label', children: '执行结果' }),
                        jsx('pre', {
                          children:
                            rawOutputText.length > 16_000
                              ? `${rawOutputText.slice(0, 16_000)}\n… 输出较长，此处显示部分内容`
                              : rawOutputText,
                        }),
                      ],
                    }),
                ],
              }),
            ],
          }),
      }),
      isPending &&
        approvalId &&
        !decision &&
        jsxs('div', {
          className: 'tool-approval',
          children: [
            jsxs('div', {
              children: [jsx(ShieldCheck, { size: 16 }), jsx('span', { children: '此操作需要你的确认' })],
            }),
            jsxs('div', {
              className: 'approval-actions',
              children: [
                jsxs('button', {
                  type: 'button',
                  className: 'button button-quiet small-button',
                  disabled: approving,
                  onClick: () => onApprove(approvalId, false),
                  children: [jsx(X, { size: 13 }), '拒绝'],
                }),
                jsxs('button', {
                  type: 'button',
                  className: 'button button-approve small-button',
                  disabled: approving,
                  onClick: () => onApprove(approvalId, true),
                  children: [
                    approving
                      ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                      : jsx(Check, { size: 13 }),
                    '批准执行',
                  ],
                }),
              ],
            }),
          ],
        }),
    ],
  });
}

export function ToolActivityStack({
  tools,
  approvals = {},
  decisions = {},
  approving = {},
  onApprove,
  onToast,
  active = false,
}) {
  const [expandedState, setExpandedState] = React.useState(null);
  const expanded = expandedState ?? false;
  const setExpanded = (updater) =>
    setExpandedState(typeof updater === 'function' ? updater(expanded) : updater);
  const bodyId = React.useId();

  const needsApproval = (tool) =>
    active && tool.status === 'pending' && tool.approvalId && !decisions[tool.approvalId];

  const pendingTools = tools.filter(needsApproval);
  const timelineTools = tools.filter(
    (tool) => !needsApproval(tool) && tool.name !== 'update_tasks' && tool.name !== 'spawn_subagent',
  );
  const isExecuting =
    active &&
    tools.some((tool) => !needsApproval(tool) && ['pending', 'running'].includes(tool.status));
  const failedCount = timelineTools.filter(
    (tool) => tool.status === 'error' || (!active && ['pending', 'running'].includes(tool.status)),
  ).length;
  const summaryLabel = isExecuting
    ? '执行中'
    : failedCount
      ? `${failedCount} 项未完成`
      : '已完成';

  const renderCard = (tool, timeline = false) =>
    jsx(
      ToolCallCard,
      {
        tool,
        approval: approvals[tool.approvalId],
        decision: decisions[tool.approvalId],
        approving: approving[tool.approvalId],
        onApprove,
        onToast,
        active,
        timeline,
      },
      tool.id,
    );

  return jsxs('div', {
    className: 'tool-activity-stack',
    children: [
      timelineTools.length > 0 &&
        jsxs('section', {
          className: `tool-activity ${expanded ? 'is-expanded' : 'is-collapsed'}`,
          'aria-label': '工具调用记录',
          children: [
            jsxs('button', {
              type: 'button',
              className: 'tool-activity-header',
              onClick: () => setExpanded((prev) => !prev),
              'aria-expanded': expanded,
              'aria-controls': bodyId,
              'aria-label': `${expanded ? '收起' : '展开'}工具调用，${timelineTools.length} 次操作`,
              children: [
                expanded ? jsx(ChevronDown, { size: 16 }) : jsx(ChevronRight, { size: 16 }),
                jsx('strong', { children: '工具调用' }),
                jsxs('span', {
                  className: 'tool-activity-count',
                  children: [timelineTools.length, ' 次'],
                }),
                jsxs('span', {
                  className: `tool-activity-status ${failedCount ? 'has-errors' : ''}`,
                  children: [
                    isExecuting
                      ? jsx(LoaderCircle, { size: 12, className: 'spin' })
                      : failedCount
                        ? jsx(X, { size: 12 })
                        : jsx(Check, { size: 12 }),
                    summaryLabel,
                  ],
                }),
                jsx('span', {
                  className: 'tool-activity-action',
                  children: expanded ? '收起' : '展开',
                }),
              ],
            }),
            jsx('div', {
              id: bodyId,
              className: 'tool-activity-body',
              hidden: !expanded,
              children: jsx('ol', {
                className: 'tool-timeline',
                children: timelineTools.map((tool) =>
                  jsx('li', { children: renderCard(tool, true) }, tool.id),
                ),
              }),
            }),
          ],
        }),
      pendingTools.length > 0 &&
        jsx('div', {
          className: 'tool-pending-actions',
          children: pendingTools.map((tool) => renderCard(tool)),
        }),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Reasoning, Task List, Attachments, Compaction & Artifact Image Cards       */
/* -------------------------------------------------------------------------- */

export function HarnessMark({ small = false }) {
  return jsxs('span', {
    className: `harness-mark ${small ? 'small' : ''}`,
    'aria-hidden': 'true',
    children: [jsx('i', {}), jsx('i', {}), jsx('i', {}), jsx('i', {})],
  });
}

function useThrottledLiveValue(value, active, intervalMs = 260) {
  const [throttled, setThrottled] = React.useState(value);
  const latestRef = React.useRef(value);
  latestRef.current = value;

  React.useEffect(() => {
    if (!active) {
      setThrottled(latestRef.current);
      return;
    }
    const timer = setInterval(
      () => setThrottled((prev) => (prev === latestRef.current ? prev : latestRef.current)),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return throttled;
}

export function ReasoningBlock({ text, running }) {
  const [openState, setOpenState] = React.useState(null);
  const lastLine =
    (text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || '';
  const livePreview = useThrottledLiveValue(lastLine, Boolean(running));

  if (!text) return null;
  const isOpen = openState ?? false;

  return jsxs('div', {
    className: `reasoning-block ${isOpen ? 'open' : ''} ${running ? 'live' : ''}`,
    children: [
      jsxs('button', {
        type: 'button',
        className: 'reasoning-toggle',
        onClick: () => setOpenState(!isOpen),
        'aria-expanded': isOpen,
        children: [
          running
            ? jsx(LoaderCircle, { size: 14, className: 'spin' })
            : jsx(Brain, { size: 14 }),
          jsx('span', {
            className: 'reasoning-label',
            children: running ? '正在思考' : '思考过程',
          }),
          !isOpen &&
            jsx('span', {
              className: 'reasoning-preview',
              title: livePreview,
              children: livePreview,
            }),
          isOpen && jsx('span', { className: 'reasoning-hint', children: '可折叠' }),
          jsx(ChevronDown, { size: 14, className: 'reasoning-chevron' }),
        ],
      }),
      isOpen && jsx('div', { className: 'reasoning-body', children: text }),
    ],
  });
}

export function TaskListSection({ tasks, running }) {
  const [open, setOpen] = React.useState(false);
  const items = (tasks ?? []).filter((item) => item?.text);
  if (!items.length) return null;

  const completedCount = items.filter((item) => item.status === 'completed').length;
  const activeItem = items.find((item) => item.status === 'in_progress');
  const allComplete = completedCount === items.length;

  return jsxs('section', {
    className: `task-list ${allComplete ? 'is-complete' : ''} ${open ? 'open' : 'collapsed'}`,
    'aria-label': '任务清单',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'task-list-heading',
        onClick: () => setOpen((prev) => !prev),
        'aria-expanded': open,
        children: [
          jsx(ListChecks, { size: 14 }),
          jsx('strong', { children: '任务清单' }),
          jsxs('span', {
            className: 'task-list-progress',
            children: [completedCount, ' / ', items.length, ' 已完成'],
          }),
          jsx('span', {
            className: 'task-list-bar',
            'aria-hidden': 'true',
            children: jsx('i', {
              style: { width: `${Math.round((completedCount / items.length) * 100)}%` },
            }),
          }),
          !open &&
            activeItem &&
            jsxs('span', {
              className: 'task-list-active',
              title: activeItem.text,
              children: [
                jsx(LoaderCircle, { size: 12, className: running ? 'spin' : '' }),
                activeItem.text,
              ],
            }),
          jsx(ChevronDown, { size: 14, className: 'task-list-chevron' }),
        ],
      }),
      open &&
        jsx('ol', {
          className: 'task-list-items',
          children: items.map((item) =>
            jsxs(
              'li',
              {
                className: `task-item status-${item.status}`,
                children: [
                  jsx('span', {
                    className: 'task-item-mark',
                    'aria-hidden': 'true',
                    children:
                      item.status === 'completed'
                        ? jsx(Check, { size: 12 })
                        : item.status === 'in_progress'
                          ? jsx(LoaderCircle, { size: 12, className: 'spin' })
                          : jsx(CircleDashed, { size: 12 }),
                  }),
                  jsx('span', { className: 'task-item-text', children: item.text }),
                  jsx('span', {
                    className: 'task-item-state',
                    children:
                      item.status === 'completed'
                        ? '已完成'
                        : item.status === 'in_progress'
                          ? '进行中'
                          : '待做',
                  }),
                ],
              },
              item.id || item.text,
            ),
          ),
        }),
    ],
  });
}

function SmallAttachmentIcon({ kind }) {
  const IconComp =
    kind === 'image'
      ? FileImage
      : kind === 'sheet'
        ? FileSpreadsheet
        : kind === 'archive'
          ? FileArchive
          : kind === 'text'
            ? File
            : FileCodeCorner;
  return jsx(IconComp, { size: 12 });
}

function UserMessageAttachments({ attachments, sessionId, onPreview }) {
  const valid = (attachments ?? []).filter((att) => att?.name);
  if (!valid.length) return null;

  return jsx('div', {
    className: 'user-attachments',
    children: valid.map((att) => {
      const kind = classifyAttachmentKind(att);
      const imageUrl = kind === 'image' ? attachmentPreviewUrl(att, sessionId) : '';
      return jsxs(
        'span',
        {
          className: `user-attachment kind-${kind}`,
          title: att.path || att.name,
          children: [
            imageUrl
              ? jsx('button', {
                  type: 'button',
                  className: 'user-attachment-thumb',
                  'aria-label': `放大查看 ${att.name}`,
                  onClick: () => onPreview?.({ url: imageUrl, name: att.name, mime: att.mime }),
                  children: jsx('img', {
                    src: imageUrl,
                    alt: att.name,
                    decoding: 'async',
                    referrerPolicy: 'no-referrer',
                  }),
                })
              : jsx(SmallAttachmentIcon, { kind }),
            jsx('span', { children: att.name }),
            att.size ? jsx('small', { children: formatBytes(att.size) }) : null,
          ],
        },
        att.ref || att.name,
      );
    }),
  });
}

function CompactionNoticeList({ compactions }) {
  const finished = (compactions || []).filter((item) => item && item.status !== 'running');
  if (!finished.length) return null;

  return jsx('div', {
    className: 'compaction-notices',
    children: finished.map((item) => {
      const isError = item.status === 'error';
      const isAuto = item.trigger === 'auto';
      const heading = isError
        ? '压缩未完成'
        : isAuto
          ? '已自动压缩较早的历史'
          : '已压缩较早的历史';
      const detail = isError
        ? item.reason || '对话历史保持原样。'
        : `${[
            item.summarizedCount ? `${item.summarizedCount} 条消息已替换为摘要` : '',
            item.keptCount ? `最近 ${item.keptCount} 条保持原样` : '',
          ]
            .filter(Boolean)
            .join('，')}。`;

      return jsxs(
        'div',
        {
          className: `compaction-notice${isError ? ' failed' : ''}`,
          children: [
            jsx(Minimize2, { size: 13 }),
            jsxs('div', {
              children: [
                jsx('strong', { children: heading }),
                detail && jsx('span', { children: detail }),
              ],
            }),
          ],
        },
        item.id,
      );
    }),
  });
}

export function ArtifactImageCard({ artifact, onPreview, onToast, compact = false }) {
  const [loadedUrl, setLoadedUrl] = React.useState('');
  const [failedUrl, setFailedUrl] = React.useState('');
  const [retryCount, setRetryCount] = React.useState(0);
  const [naturalDimensions, setNaturalDimensions] = React.useState(null);
  const [copyState, setCopyState] = React.useState('idle');

  const safeUrl = sanitizeImageSrc(artifact.url);
  const isLoaded = loadedUrl === safeUrl;
  const isFailed = failedUrl === safeUrl;
  const canRenderImage =
    safeUrl && (!artifact.mime || (/^image\//.test(artifact.mime) && !/svg/i.test(artifact.mime)));
  const displayName = artifact.name || '生成的图片';
  const dimensionsLabel =
    artifact.width && artifact.height
      ? `${artifact.width} × ${artifact.height}`
      : isLoaded
        ? naturalDimensions
        : null;

  if (!canRenderImage) {
    return jsxs('div', {
      className: 'image-unavailable',
      title: artifact.url || '',
      children: [
        jsx(ImageOff, { size: 18 }),
        jsxs('span', {
          children: ['这个图片地址暂不支持在对话里显示', artifact.url ? `：${artifact.url}` : ''],
        }),
      ],
    });
  }

  return jsxs('figure', {
    className: `artifact-image ${compact ? 'compact' : ''}`,
    children: [
      jsx('div', {
        className: `artifact-frame ${isLoaded ? 'loaded' : ''}`,
        children: isFailed
          ? jsxs('div', {
              className: 'image-failure',
              children: [
                jsx(ImageOff, { size: 24 }),
                jsx('span', { children: '图片暂时无法加载' }),
                jsxs('button', {
                  className: 'text-button',
                  onClick: () => {
                    setFailedUrl('');
                    setLoadedUrl('');
                    setRetryCount((prev) => prev + 1);
                  },
                  children: [jsx(RefreshCw, { size: 13 }), '重新加载'],
                }),
              ],
            })
          : jsxs('button', {
              className: 'image-preview-button',
              onClick: () => onPreview({ ...artifact, url: safeUrl }),
              'aria-label': `放大查看${displayName}`,
              children: [
                !isLoaded &&
                  jsxs('span', {
                    className: 'image-loading',
                    children: [
                      jsx(LoaderCircle, { size: 22, className: 'spin' }),
                      jsx('span', { children: '正在载入图片' }),
                    ],
                  }),
                jsx(
                  'img',
                  {
                    src: safeUrl,
                    alt: displayName,
                    loading: 'lazy',
                    decoding: 'async',
                    referrerPolicy: 'no-referrer',
                    onLoad: (ev) => {
                      setLoadedUrl(safeUrl);
                      setNaturalDimensions(
                        `${ev.currentTarget.naturalWidth} × ${ev.currentTarget.naturalHeight}`,
                      );
                    },
                    onError: () => setFailedUrl(safeUrl),
                  },
                  `${safeUrl}-${retryCount}`,
                ),
                isLoaded &&
                  jsx('span', {
                    className: 'image-expand',
                    children: jsx(Expand, { size: 15 }),
                  }),
              ],
            }),
      }),
      jsxs('figcaption', {
        children: [
          jsxs('div', {
            children: [
              jsx('span', {
                className: 'artifact-name',
                title: displayName,
                children: displayName,
              }),
              dimensionsLabel &&
                jsx('span', { className: 'artifact-size', children: dimensionsLabel }),
            ],
          }),
          safeUrl &&
            jsx('button', {
              type: 'button',
              className: 'icon-button small',
              title: '复制图片',
              'aria-label': '复制图片',
              disabled: copyState === 'busy',
              onClick: async () => {
                setCopyState('busy');
                try {
                  await copyImageToClipboard(safeUrl);
                  setCopyState('done');
                  onToast?.('图片已复制到剪贴板');
                  setTimeout(() => setCopyState('idle'), 2000);
                } catch (err) {
                  setCopyState('idle');
                  onToast?.(err?.message || '复制失败，请改用下载后手动复制。', 'error');
                }
              },
              children:
                copyState === 'busy'
                  ? jsx(LoaderCircle, { size: 16, className: 'spin' })
                  : copyState === 'done'
                    ? jsx(Check, { size: 16 })
                    : jsx(Copy, { size: 16 }),
            }),
          jsx('a', {
            className: 'icon-button small',
            href: artifactDownloadUrl(artifact),
            download: artifact.name || 'image',
            title: '下载图片',
            'aria-label': '下载图片',
            children: jsx(ArrowDownToLine, { size: 16 }),
          }),
        ],
      }),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Code Blocks, Markdown Body & Reply UI Bindings                             */
/* -------------------------------------------------------------------------- */

function CodeBlockPre({ children, onToast }) {
  const preRef = React.useRef(null);
  const codeElement = React.Children.toArray(children).find((child) =>
    React.isValidElement(child),
  );
  const languageLabel =
    codeElement?.props?.className?.replace('language-', '') || '代码';

  return jsxs('div', {
    className: 'code-block',
    children: [
      jsxs('div', {
        className: 'code-toolbar',
        children: [
          jsx('span', { children: languageLabel }),
          jsx('button', {
            className: 'icon-button small',
            title: '复制代码',
            'aria-label': '复制代码',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(preRef.current?.textContent || '');
                onToast('代码已复制');
              } catch {
                onToast('复制失败，请手动选中代码复制', 'error');
              }
            },
            children: jsx(Copy, { size: 13 }),
          }),
        ],
      }),
      jsx('pre', { ref: preRef, children }),
    ],
  });
}

function containsImgElement(hastNode) {
  return hastNode?.tagName === 'img' || Boolean(hastNode?.children?.some(containsImgElement));
}

const EMPTY_ARRAY = [];

export function MarkdownBody({
  text,
  artifacts = EMPTY_ARRAY,
  sessionId,
  onPreview,
  onToast,
}) {
  const components = React.useMemo(
    () => ({
      pre: ({ children }) => jsx(CodeBlockPre, { onToast, children }),
      p: ({ node, children }) =>
        containsImgElement(node)
          ? jsx('div', { className: 'markdown-media-paragraph', children })
          : jsx('p', { children }),
      a: ({ node, href, children }) =>
        containsImgElement(node)
          ? jsx('div', { className: 'markdown-image-link', children })
          : href
            ? jsx('a', {
                href,
                target: href.startsWith('/api/') ? undefined : '_blank',
                rel: 'noreferrer noopener',
                children,
              })
            : jsx('span', { children }),
      img: ({ src, alt }) => {
        const resolvedUrl = sanitizeImageSrc(src) || workspaceRelativeImageUrl(src, sessionId);
        const matchedArtifact = artifacts.find(
          (item) => item.url === resolvedUrl || item.url === src,
        ) || {
          url: resolvedUrl || src,
          name: alt || '生成的图片',
          sessionId,
        };
        return jsx(ArtifactImageCard, {
          artifact: matchedArtifact,
          onPreview,
          onToast,
        });
      },
    }),
    [artifacts, sessionId, onPreview, onToast],
  );

  return jsx('div', {
    className: 'markdown-body',
    children: jsx(ReactMarkdown, {
      remarkPlugins: REMARK_PLUGINS,
      rehypePlugins: REHYPE_PLUGINS,
      skipHtml: true,
      urlTransform: (value, key) =>
        key === 'src'
          ? sanitizeImageSrc(value) || localImageUrl(value, sessionId)
          : safeMarkdownUrlTransform(value, key),
      components,
      children: text || '',
    }),
  });
}

const { MessageBranchButton: HgBranchButton } = createBranchUI(React);

export const {
  Flow: ReplyFlow,
  Activity: ReplyActivity,
  WaitingButton: ReplyWaitingButton,
  ImageViewer: ReplyImageViewer,
} = createReplyUI(React, {
  Markdown: MarkdownBody,
  Tool: ToolCallCard,
  Artifact: ArtifactImageCard,
  Subagent: SubagentCard,
  copyImage: copyImageToClipboard,
  downloadUrl: artifactDownloadUrl,
  safeImage: sanitizeImageSrc,
});

function MessageErrorNotice({ text, onToast }) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const hasDetail = Boolean(trimmed) && trimmed !== '这次回复未能完成。';

  return jsxs('div', {
    className: 'message-error',
    role: 'note',
    children: [
      jsxs('div', {
        className: 'message-status-note error',
        children: [
          jsx(X, { size: 13 }),
          jsxs('span', { children: ['这次回复未能完成', hasDetail ? '：' : ''] }),
          hasDetail &&
            jsx('button', {
              type: 'button',
              className: 'message-error-copy',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(trimmed);
                  onToast?.('错误信息已复制');
                } catch {
                  onToast?.('复制失败，请手动选中错误信息复制', 'error');
                }
              },
              title: '复制错误信息',
              'aria-label': '复制错误信息',
              children: jsx(Copy, { size: 12 }),
            }),
        ],
      }),
      hasDetail && jsx('pre', { className: 'message-error-text', children: trimmed }),
    ],
  });
}

function MessageItemInner({
  message,
  sessionId,
  isRunning,
  approvals,
  decisions,
  approving,
  onApprove,
  onPreview,
  onToast,
}) {
  const isUser = message.role === 'user';
  const artifacts = message.artifacts || EMPTY_ARRAY;
  const inlineImageUrls = new Set(
    Array.from(
      (message.text || '').matchAll(
        /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
      ),
      (match) => match[1],
    ),
  );
  const extraArtifacts = artifacts.filter((art) => !inlineImageUrls.has(art.url));
  const reasoning = message.reasoning || '';
  const showInitialThinking =
    isRunning && !message.text && !reasoning && !message.tools?.length && !artifacts.length;
  const modeBadgeLabel =
    message.mode === 'image' ? '图片生成' : message.mode === 'agent' ? '编程助手' : '';

  if (isUser) {
    return jsxs('article', {
      className: 'message message-user',
      'data-message-id': message.id,
      children: [
        jsxs('div', {
          className: 'user-bubble',
          children: [
            message.skill?.name &&
              jsxs('span', {
                className: 'user-skill-tag',
                title: message.skill.text,
                children: [jsx(Zap, { size: 11 }), message.skill.name],
              }),
            message.text ||
              jsx('span', { className: 'user-bubble-empty', children: '（仅附件）' }),
            jsx(UserMessageAttachments, {
              attachments: message.attachments,
              sessionId,
              onPreview,
            }),
          ],
        }),
        jsx('span', { className: 'message-time', children: formatClockTime(message.createdAt) }),
      ],
    });
  }

  return jsxs('article', {
    className: `message message-assistant ${message.status === 'error' ? 'message-has-error' : ''}`,
    'data-message-id': message.id,
    children: [
      jsxs('div', {
        className: 'assistant-message-head',
        children: [
          jsx(HarnessMark, { small: true }),
          jsx('strong', { children: 'Harness Gemini' }),
          modeBadgeLabel && jsx('span', { className: 'message-mode', children: modeBadgeLabel }),
          jsx('span', { className: 'message-time', children: formatClockTime(message.createdAt) }),
        ],
      }),
      jsxs('div', {
        className: 'assistant-message-content',
        children: [
          jsx(ReplyFlow, {
            message,
            sessionId,
            active: isRunning && message.status === 'running',
            approvals,
            decisions,
            approving,
            onApprove,
            onPreview,
            onToast,
            onActivity: () => window.dispatchEvent(new CustomEvent('reply-activity-open')),
          }),
          jsx(CompactionNoticeList, { compactions: message.compactions }),
          extraArtifacts.length > 0 &&
            message.mode === 'image' &&
            jsx('div', {
              className: `message-artifacts ${extraArtifacts.length > 1 ? 'multiple' : ''}`,
              children: extraArtifacts.map((art) =>
                jsx(
                  ArtifactImageCard,
                  { artifact: art, onPreview, onToast },
                  art.id || art.url,
                ),
              ),
            }),
          message.notice &&
            (message.noticeKind === 'busy'
              ? jsxs('div', {
                  className: 'message-notice',
                  children: [
                    jsx(LoaderCircle, { size: 13, className: 'spin' }),
                    jsx('span', { children: message.notice }),
                  ],
                })
              : jsxs('div', {
                  className: 'message-notice info',
                  children: [jsx(Info, { size: 13 }), jsx('span', { children: message.notice })],
                })),
          showInitialThinking &&
            jsxs('div', {
              className: 'thinking-indicator',
              children: [
                jsxs('span', {
                  className: 'thinking-dots',
                  children: [jsx('i', {}), jsx('i', {}), jsx('i', {})],
                }),
                jsx('span', {
                  children:
                    message.mode === 'image'
                      ? '正在生成图片，完成后会显示在这里'
                      : message.mode === 'agent'
                        ? '正在查看任务，准备下一步'
                        : '正在思考',
                }),
              ],
            }),
          !isRunning &&
            message.status === 'cancelled' &&
            jsxs('div', {
              className: 'message-status-note',
              children: [
                jsx('span', { className: 'tiny-square' }),
                '已停止 · 已收到的内容已保留',
              ],
            }),
          !isRunning &&
            message.status === 'error' &&
            jsx(MessageErrorNotice, { text: message.error, onToast }),
          !isRunning &&
            message.text &&
            jsxs('div', {
              className: 'message-actions',
              children: [
                jsx(HgBranchButton, { sessionId, message }),
                jsx('button', {
                  className: 'icon-button small',
                  title: '复制回复',
                  'aria-label': '复制回复',
                  onClick: async () => {
                    try {
                      await navigator.clipboard.writeText(message.text);
                      onToast('回复已复制');
                    } catch {
                      onToast('复制失败，请手动选中内容复制', 'error');
                    }
                  },
                  children: jsx(Copy, { size: 14 }),
                }),
              ],
            }),
        ],
      }),
    ],
  });
}

export const MessageItem = React.memo(MessageItemInner);
