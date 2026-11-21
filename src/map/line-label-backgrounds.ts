import { LINE_LABEL_BACKGROUND_LAYER_ID } from './highlight-layer';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Line-name labels ("Lioness line", "DLR", …) are the only text in the map's `.small` group. */
export const LINE_LABEL_SELECTOR = '#text #stname > .small text';
const HORIZONTAL_PADDING = 3;
/** Character boxes stop just short of the tails of letters like "y", so each background extends a little below its line. */
const BOTTOM_PADDING = 0.5;
const CORNER_RADIUS = 4;

interface TextLine {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The extent of each line of a label's text, in the label's own coordinates. Labels such as "Northern / line" are
 * set on two lines, so each line gets a background that fits it, rather than one box with empty space beside the
 * shorter line. Spaces are left out, so a line's background ends where its words do.
 */
function measureTextLines(label: SVGTextElement): TextLine[] {
  const text = label.textContent ?? '';
  const lines = new Map<number, TextLine>();
  const count = label.getNumberOfChars();
  for (let index = 0; index < count; index += 1) {
    if (/\s/.test(text[index] ?? '')) continue;
    const extent = label.getExtentOfChar(index);
    const key = Math.round(extent.y);
    const line = lines.get(key);
    if (!line) lines.set(key, { left: extent.x, right: extent.x + extent.width, top: extent.y, bottom: extent.y + extent.height });
    else {
      line.left = Math.min(line.left, extent.x);
      line.right = Math.max(line.right, extent.x + extent.width);
      line.top = Math.min(line.top, extent.y);
      line.bottom = Math.max(line.bottom, extent.y + extent.height);
    }
  }
  return [...lines.values()].sort((a, b) => a.top - b.top);
}

function createBackground(svg: SVGSVGElement, labelIndex: number, transform: string, box: { x: number; y: number; width: number; height: number }, rounded: boolean) {
  const background = svg.ownerDocument.createElementNS(SVG_NS, 'rect');
  background.setAttribute('class', 'app-line-label-background');
  background.setAttribute('data-label', String(labelIndex));
  background.setAttribute('x', String(box.x));
  background.setAttribute('y', String(box.y));
  background.setAttribute('width', String(box.width));
  background.setAttribute('height', String(box.height));
  if (rounded) background.setAttribute('rx', String(CORNER_RADIUS));
  else background.setAttribute('data-join', '');
  background.setAttribute('transform', transform);
  return background;
}

/**
 * Puts a rounded background behind every line of every line-name label so it stays legible over highlights and
 * shaded zones. The backgrounds sit beneath the route lines (lines still draw over them) and above the highlight
 * layers. Each background shares its label's transform, so rotated labels are covered exactly; `data-label` gives
 * the label's position among the line-name labels.
 */
export function addLineLabelBackgrounds(svg: SVGSVGElement) {
  const layer = svg.querySelector<SVGGElement>(`#${LINE_LABEL_BACKGROUND_LAYER_ID}`);
  const layerMatrix = layer?.getScreenCTM();
  if (!layer || !layerMatrix || layer.childElementCount > 0) return;
  const screenToLayer = layerMatrix.inverse();

  svg.querySelectorAll<SVGTextElement>(LINE_LABEL_SELECTOR).forEach((label, labelIndex) => {
    const labelMatrix = label.getScreenCTM();
    if (!labelMatrix) return;
    const { a, b, c, d, e, f } = screenToLayer.multiply(labelMatrix);
    const transform = `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
    const lines = measureTextLines(label);
    lines.forEach((line, index) => {
      const left = line.left - HORIZONTAL_PADDING;
      const right = line.right + HORIZONTAL_PADDING;
      layer.appendChild(createBackground(svg, labelIndex, transform, { x: left, y: line.top, width: right - left, height: line.bottom + BOTTOM_PADDING - line.top }, true));
      // Where two lines' backgrounds meet, a square piece over their rounded corners joins them into one shape, so the
      // edge they share runs straight instead of pinching in between the lines.
      const next = lines[index + 1];
      if (!next) return;
      const sharedLeft = Math.max(left, next.left - HORIZONTAL_PADDING);
      const sharedRight = Math.min(right, next.right + HORIZONTAL_PADDING);
      const top = Math.min(line.bottom + BOTTOM_PADDING, next.top) - CORNER_RADIUS;
      const bottom = Math.max(line.bottom + BOTTOM_PADDING, next.top) + CORNER_RADIUS;
      if (sharedRight > sharedLeft) {
        layer.appendChild(createBackground(svg, labelIndex, transform, { x: sharedLeft, y: top, width: sharedRight - sharedLeft, height: bottom - top }, false));
      }
    });
  });
}
