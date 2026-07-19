import EventEmitter from 'eventemitter3';
import { debounce } from 'obsidian';

import { Entity } from '../types';
import { getParentWindow } from '../util/getWindow';
import { DragManager } from './DragManager';

export type DropHandler = (dragEntity: Entity, dropEntity: Entity) => void;

export class DndManager {
  win: Window;
  emitter: EventEmitter;
  hitboxEntities: Map<string, Entity>;
  scrollEntities: Map<string, Entity>;
  resizeObserver: ResizeObserver;
  dragManager: DragManager;
  onDrop: DropHandler;

  constructor(win: Window, onDrop: DropHandler) {
    this.win = win;
    this.emitter = new EventEmitter();
    this.hitboxEntities = new Map();
    this.scrollEntities = new Map();
    this.onDrop = onDrop;

    this.resizeObserver = new ResizeObserver(this.onResizeEntries);
    this.flushResize = debounce(this.processResize, 100, true);
    this.dragManager = new DragManager(win, this.emitter, this.hitboxEntities, this.scrollEntities);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  scrollResizeDebounce = 0;
  flushResize: () => void;

  // Targets accumulated across debounced calls so none are dropped (the raw
  // ResizeObserver callback only exposes its own batch's entries).
  private pendingHitboxTargets = new Set<HTMLElement>();
  private pendingScrollResize = false;

  onResizeEntries: ResizeObserverCallback = (entries) => {
    let thisDidResize = false;
    entries.forEach((e) => {
      const target = e.target as HTMLElement;

      if (this.win !== getParentWindow(target)) return;

      thisDidResize = true;

      if (target.dataset.scrollid) {
        this.pendingScrollResize = true;
      } else if (target.dataset.hitboxid) {
        this.pendingHitboxTargets.add(target);
      }
    });

    if (thisDidResize) this.flushResize();
  };

  processResize = () => {
    // A hitbox element resizing reflows its in-flow siblings (which do not
    // themselves resize, so the observer never fires for them). Scope the
    // recalc to the resized element's scroll container so those siblings are
    // refreshed too, without touching unrelated lanes/boards. A scroll
    // container resizing can shift geometry across containers, so fall back to
    // a full hitbox recalc in that (rare) case.
    let recalcAllHitboxes = this.pendingScrollResize;
    const scopedHitboxIds = new Set<string>();

    this.pendingHitboxTargets.forEach((target) => {
      const container = target.closest<HTMLElement>('[data-scrollid]');

      if (!container) {
        recalcAllHitboxes = true;
        return;
      }

      container.querySelectorAll<HTMLElement>('[data-hitboxid]').forEach((node) => {
        if (node.dataset.hitboxid) scopedHitboxIds.add(node.dataset.hitboxid);
      });
    });

    this.pendingHitboxTargets.clear();

    if (recalcAllHitboxes) {
      this.hitboxEntities.forEach((entity) => {
        entity.recalcInitial();
      });
    } else {
      scopedHitboxIds.forEach((id) => {
        this.hitboxEntities.get(id)?.recalcInitial();
      });
    }

    // Scroll entities are few (four per container) and cheap, and content
    // resizes can shift their scroll geometry, so recalc them all.
    this.scrollEntities.forEach((entity) => {
      entity.recalcInitial();
    });

    if (this.pendingScrollResize) {
      this.pendingScrollResize = false;
      this.win.clearTimeout(this.scrollResizeDebounce);

      this.scrollResizeDebounce = this.win.setTimeout(() => {
        if (this.emitter.listenerCount('scrollResize')) {
          this.emitter.emit('scrollResize', null);
        }
      }, 50);
    }
  };

  observeResize(element: HTMLElement) {
    if (!element.instanceOf(HTMLElement)) return;
    this.resizeObserver.observe(element, { box: 'border-box' });
  }

  unobserveResize(element: HTMLElement) {
    if (!element.instanceOf(HTMLElement)) return;
    this.resizeObserver.unobserve(element);
  }

  registerHitboxEntity(id: string, entity: Entity, win: Window) {
    if (win !== this.win) return;
    this.hitboxEntities.set(id, entity);
    this.dragManager?.invalidateEntities();
  }

  registerScrollEntity(id: string, entity: Entity, win: Window) {
    if (win !== this.win) return;
    this.scrollEntities.set(id, entity);
    this.dragManager?.invalidateEntities();
  }

  unregisterHitboxEntity(id: string, win: Window) {
    if (win !== this.win) return;
    this.hitboxEntities.delete(id);
    this.dragManager?.invalidateEntities();
  }

  unregisterScrollEntity(id: string, win: Window) {
    if (win !== this.win) return;
    this.scrollEntities.delete(id);
    this.dragManager?.invalidateEntities();
  }
}
