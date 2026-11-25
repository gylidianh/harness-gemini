/** Row/column copying for the GFM tables rendered by MarkdownBody. License: MIT */
import { React, jsx } from '../vendor/vendor-deps.js';

// Use the rendered markdown tree, not the raw pipes or tool/button text. In a
// KaTeX cell the MathML and visual layers both contain the equation; take it once.
function cellText(node) {
  if (node.type === 'text') return node.value;
  if (node.tagName === 'br') return '\n';
  if (node.tagName === 'img') return node.properties?.alt || '';
  if (node.tagName === 'input' && node.properties?.type === 'checkbox') return node.properties.checked ? '☑' : '☐';
  if (node.properties?.className?.includes('katex')) {
    const math = node.children?.find(n => n.properties?.className?.includes('katex-mathml'));
    const annotation = math?.children?.[0]?.children?.[0]?.children?.find(n => n.tagName === 'annotation');
    if (annotation) return cellText(annotation);
  }
  return (node.children || []).map(cellText).join('');
}

function dataRows(node) {
  return node.children.flatMap(section => (section.children || [])
    .filter(row => row.tagName === 'tr')
    .map(row => row.children.filter(cell => cell.tagName === 'th' || cell.tagName === 'td')));
}

function tsvField(text) {
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Coordinates exclude the sheet headings; row zero is the Markdown header.
const span = (a,b) => Array.from({length: Math.abs(b-a)+1}, (_,i) => Math.min(a,b)+i);
const union = (base, range, limit) => [...new Set([...base,...range])].filter(i=>i<limit).sort((a,b)=>a-b);
// Narrow hit areas inside the first column/header replace the extra sheet headings.
function position(cell, e) {
  const r=cell.parentElement.rowIndex, c=cell.cellIndex, box=cell.getBoundingClientRect();
  const left=c===0 && e.clientX-box.left<Math.min(7,box.width/4);
  const top=r===0 && e.clientY-box.top<Math.min(7,box.height/4);
  return {r,c,kind:top?(left?'all':'col'):left?'row':'cell'};
}
function region(start,end,base=[]) { return {start,end,base}; }
export function SelectableTable({node,children,...tableProps}) {
  const rows=React.useMemo(()=>dataRows(node),[node]);
  const width=rows.reduce((n,row)=>Math.max(n,row.length),0);
  const [sel,select]=React.useState(null);
  const drag=React.useRef(null), table=React.useRef(null);
  // In text mode only this cell delegates pointer gestures to Chromium's native selection.
  const [textCell,setTextCell]=React.useState(null);
  React.useEffect(()=>{
    if(!textCell)return;
    function outside(e) { if(!textCell.contains(e.target))setTextCell(null); }
    document.addEventListener('pointerdown',outside,true);
    return ()=>document.removeEventListener('pointerdown',outside,true);
  },[textCell]);
  const kind=sel?.start.kind;
  const rowIds=React.useMemo(()=>!sel?[]:kind==='col'||kind==='all'?span(0,rows.length-1):union(sel.base,span(sel.start.r,sel.end.r),rows.length),[sel,rows.length,kind]);
  const colIds=React.useMemo(()=>!sel?[]:kind==='row'||kind==='all'?span(0,width-1):union(sel.base,span(sel.start.c,sel.end.c),width),[sel,width,kind]);
  const rr=new Set(rowIds), cc=new Set(colIds);
  function text() { return rowIds.map(r=>colIds.map(c=>tsvField(rows[r]?.[c]?cellText(rows[r][c]):'')).join('\t')).join('\r\n'); }
  function begin(e) {
    if(!e.isPrimary || e.button!==0 || e.pointerType==='touch' || e.altKey || e.target.closest('a,button,input,textarea,[contenteditable=true]')) return;
    const cell=e.target.closest('th,td'); if(!cell || cell.closest('table')!==table.current) return;
    if(cell===textCell)return;
    const p=position(cell,e), start=e.shiftKey&&sel?.start.kind===p.kind?sel.start:p;
    const base=(e.ctrlKey||e.metaKey)&&p.kind===kind&&(kind==='row'||kind==='col')?(kind==='row'?rowIds:colIds):[];
    e.preventDefault(); window.getSelection()?.removeAllRanges(); table.current.focus({preventScroll:true});
    cell.setPointerCapture(e.pointerId); drag.current={id:e.pointerId,start,base,cell};
    select(region(start,p,base));
  }
  function move(e) {
    const d=drag.current, t=table.current; if(!d) {
      const cell=e.target.closest('td,th');
      if(cell && cell.closest('table')===t) {
        if(cell===textCell) { cell.style.cursor='text'; return; }
        const k=position(cell,e).kind;
        cell.style.cursor=({row:'e-resize',col:'s-resize',all:'crosshair'})[k] || '';
      }
      return;
    }
    if(d.id!==e.pointerId || !t) return;
    const box=t.getBoundingClientRect();
    const x=Math.max(box.left+1,Math.min(box.right-1,e.clientX)), y=Math.max(box.top+1,Math.min(box.bottom-1,e.clientY));
    const cell=document.elementFromPoint(x,y)?.closest('td,th'); if(!cell || cell.closest('table')!==t) return;
    const p=position(cell,e); p.r=Math.max(0,p.r); p.c=Math.max(0,p.c);
    select(prev=>prev?.end.r===p.r && prev?.end.c===p.c ? prev : region(d.start,p,d.base));
  }
  function end(e) { if(drag.current?.id!==e.pointerId)return; const {cell}=drag.current; drag.current=null; if(cell.hasPointerCapture(e.pointerId))cell.releasePointerCapture(e.pointerId); }
  function selectCellText(e) {
    if(e.button!==0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.target.closest('a,button,input,textarea,[contenteditable=true]')) return;
    const cell=e.target.closest('td,th');
    if(!cell || cell.closest('table')!==table.current || position(cell,e).kind!=='cell') return;
    const selection=window.getSelection(); if(!selection) return;
    if(cell===textCell)return;
    e.preventDefault(); select(null); setTextCell(cell); cell.style.cursor='text';
    selection.removeAllRanges();
  }
  function keys(e) {
    if(textCell) {
      if(e.key==='Escape') { window.getSelection()?.removeAllRanges(); textCell.style.cursor=''; setTextCell(null); e.preventDefault(); }
      return;
    }
    if(e.target===table.current && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='a') { e.preventDefault(); window.getSelection()?.removeAllRanges(); const p={r:0,c:0,kind:'all'}; select(region(p,p)); return; }
    if(e.target===table.current && e.key==='Escape') { window.getSelection()?.removeAllRanges(); select(null); return; }
    if(e.target!==table.current || !['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key))return;
    e.preventDefault(); window.getSelection()?.removeAllRanges(); const p=sel?.end??{r:0,c:0}; const next={kind:'cell',r:Math.max(0,Math.min(rows.length-1,p.r+(e.key==='ArrowDown')-(e.key==='ArrowUp'))),c:Math.max(0,Math.min(width-1,p.c+(e.key==='ArrowRight')-(e.key==='ArrowLeft')))};
    select(region(e.shiftKey&&kind==='cell'?sel.start:next,next));
  }
  let ri=-1;
  const sections=React.Children.map(children,section=>{
    if(!React.isValidElement(section)||!['thead','tbody'].includes(section.type))return section;
    const body=React.Children.map(section.props.children,row=>{
      if(!React.isValidElement(row)||row.type!=='tr')return row;
      const r=++ri; let c=-1;
      const cells=React.Children.map(row.props.children,cell=>{
        if(!React.isValidElement(cell)||!['td','th'].includes(cell.type))return cell;
        ++c; return React.cloneElement(cell,{'data-hg-text':textCell && textCell.parentElement?.rowIndex===r && textCell.cellIndex===c?'':undefined,'data-hg-picked':rr.has(r)&&cc.has(c)?'':undefined});
      });
      return React.cloneElement(row,{},cells);
    });
    return React.cloneElement(section,{},body);
  });
  const hint='双击进入格内选字，再拖动选择部分文字，Esc 退出，拖动单元格框选，拖左边缘选行、上边缘选列，Ctrl+A 全选，Ctrl+C 复制';
  return jsx('div',{className:'hg-answer-table hg-sheet-scroll',onCopy:e=>{
    if(!sel || !window.getSelection()?.isCollapsed || e.target.closest('input,textarea,[contenteditable=true]') || !e.clipboardData)return;
    e.clipboardData.setData('text/plain',text()); e.preventDefault();
  },children:jsx('table',{...tableProps,ref:table,tabIndex:0,'aria-label':`回答表格：${hint}`,onDoubleClick:selectCellText,onPointerDown:begin,onPointerMove:move,onPointerUp:end,onPointerCancel:end,onLostPointerCapture:end,onKeyDown:keys,children:sections})});
}
