/**
 * The in-artifact marker overlay (ADR 0005): one Shadow DOM host appended to the
 * artifact body, holding a numbered outline per annotation plus a transient
 * hover preview. Shadow encapsulation keeps the artifact's CSS cascade pristine
 * - the styles here are hand-authored and shadow-scoped (not Tailwind, ADR 0004)
 * and mirror the chrome's shadcn neutral palette. Markers are positioned in the
 * host's own coordinate space (each target's viewport rect minus the host's), so
 * they track document scroll for free; a capture-phase scroll/resize pass
 * re-syncs nested scrollers and reflow. The Bridge carries annotation data, never
 * geometry - this overlay computes its own.
 */

const OVERLAY_STYLES = `
  :host { all: initial; }
  .marker {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid #1a1a1f;
    border-radius: 4px;
    pointer-events: none;
  }
  .badge {
    position: absolute;
    top: -9px;
    left: -9px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    background: #1a1a1f;
    color: #ffffff;
    font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  .preview {
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed #6b6b76;
    border-radius: 4px;
    background: rgba(26, 26, 31, 0.04);
    pointer-events: none;
  }
`;

interface Marker {
  readonly id: string;
  readonly target: Element;
  readonly box: HTMLElement;
  readonly badge: HTMLElement;
}

/** The overlay handle the SDK drives as annotations are added and removed. */
export interface MarkerOverlay {
  /** The shadow host in the light DOM, excluded from being an annotation target. */
  readonly host: HTMLElement;
  /** Render a numbered marker over `target`, keyed by the annotation `id`. */
  readonly addMarker: (id: string, target: Element) => void;
  /** Remove the marker for `id` (no-op if unknown). */
  readonly removeMarker: (id: string) => void;
  /** Outline `target` as the hover preview, or clear it when `null`. */
  readonly previewTarget: (target: Element | null) => void;
  /** Detach the overlay and its window listeners. */
  readonly destroy: () => void;
}

/** Position `box` over `target` in the host's coordinate space. */
const place = (box: HTMLElement, hostRect: DOMRect, target: Element): void => {
  const rect = target.getBoundingClientRect();
  box.style.left = `${rect.left - hostRect.left}px`;
  box.style.top = `${rect.top - hostRect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
};

/** Create and mount the overlay; the SDK keeps the returned handle. */
export const createOverlay = (): MarkerOverlay => {
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = OVERLAY_STYLES;
  shadow.append(style);

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.style.display = "none";
  shadow.append(preview);

  document.body.append(host);

  const markers: Marker[] = [];

  const renumber = (): void => {
    markers.forEach((marker, index) => {
      marker.badge.textContent = String(index + 1);
    });
  };

  const reposition = (): void => {
    const hostRect = host.getBoundingClientRect();
    for (const marker of markers) {
      place(marker.box, hostRect, marker.target);
    }
  };

  const addMarker = (id: string, target: Element): void => {
    const box = document.createElement("div");
    box.className = "marker";
    const badge = document.createElement("span");
    badge.className = "badge";
    box.append(badge);
    shadow.append(box);
    markers.push({ id, target, box, badge });
    place(box, host.getBoundingClientRect(), target);
    renumber();
  };

  const removeMarker = (id: string): void => {
    const index = markers.findIndex((marker) => marker.id === id);
    if (index === -1) {
      return;
    }
    const [removed] = markers.splice(index, 1);
    removed?.box.remove();
    renumber();
  };

  const previewTarget = (target: Element | null): void => {
    if (target === null || target === host) {
      preview.style.display = "none";
      return;
    }
    place(preview, host.getBoundingClientRect(), target);
    preview.style.display = "block";
  };

  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  const destroy = (): void => {
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    host.remove();
  };

  return { host, addMarker, removeMarker, previewTarget, destroy };
};
