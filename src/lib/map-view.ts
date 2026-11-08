export interface ViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScrollPosition {
  scrollLeft: number;
  scrollTop: number;
}

export function getScrollPositionToCenterBounds(
  currentPosition: ScrollPosition,
  viewport: ViewportBounds,
  target: ViewportBounds,
  content: { width: number; height: number }
): ScrollPosition {
  const maxScrollLeft = Math.max(0, content.width - viewport.width);
  const maxScrollTop = Math.max(0, content.height - viewport.height);
  const targetCenterX = target.left + target.width / 2;
  const targetCenterY = target.top + target.height / 2;
  const viewportCenterX = viewport.left + viewport.width / 2;
  const viewportCenterY = viewport.top + viewport.height / 2;

  return {
    scrollLeft: Math.min(maxScrollLeft, Math.max(0, currentPosition.scrollLeft + targetCenterX - viewportCenterX)),
    scrollTop: Math.min(maxScrollTop, Math.max(0, currentPosition.scrollTop + targetCenterY - viewportCenterY))
  };
}
