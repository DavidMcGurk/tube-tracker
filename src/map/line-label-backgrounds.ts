import { LINE_LABEL_BACKGROUND_LAYER_ID } from './highlight-layer';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Line-name labels ("Lioness line", "DLR", …) are the only text in the map's `.small` group. */
export const LINE_LABEL_SELECTOR = '#text #stname > .small text';
const HORIZONTAL_PADDING = 3;
const CORNER_RADIUS = 4;

/**
 * Puts a rounded background behind every line-name label so it stays legible over highlights and shaded zones.
 * The backgrounds sit beneath the route lines (lines still draw over them) and above the highlight layers.
 * Each background shares its label's transform, so rotated and multi-line labels are covered exactly.
 */
export function addLineLabelBackgrounds(svg: SVGSVGElement) {
  const layer = svg.querySelector<SVGGElement>(`#${LINE_LABEL_BACKGROUND_LAYER_ID}`);
  const layerMatrix = layer?.getScreenCTM();
  if (!layer || !layerMatrix || layer.childElementCount > 0) return;
  const screenToLayer = layerMatrix.inverse();

  for (const label of svg.querySelectorAll<SVGTextElement>(LINE_LABEL_SELECTOR)) {
    const labelMatrix = label.getScreenCTM();
    const box = label.getBBox();
    if (!labelMatrix || box.width === 0) continue;
    const { a, b, c, d, e, f } = screenToLayer.multiply(labelMatrix);
    const background = svg.ownerDocument.createElementNS(SVG_NS, 'rect');
    background.setAttribute('class', 'app-line-label-background');
    background.setAttribute('x', String(box.x - HORIZONTAL_PADDING));
    background.setAttribute('y', String(box.y));
    background.setAttribute('width', String(box.width + HORIZONTAL_PADDING * 2));
    background.setAttribute('height', String(box.height));
    background.setAttribute('rx', String(CORNER_RADIUS));
    background.setAttribute('transform', `matrix(${a} ${b} ${c} ${d} ${e} ${f})`);
    layer.appendChild(background);
  }
}
