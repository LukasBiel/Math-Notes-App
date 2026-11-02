import type { Action } from '../engine/shortcuts';
import { useUI } from './store';

/** Skróty, które dotyczą aplikacji, a nie samej tablicy. */
export function runAppAction(action: Action) {
  switch (action) {
    case 'newNote':
      useUI.setState({ newNote: { open: true } });
      break;
    case 'search':
      useUI.setState((s) => ({ sidebarOpen: true, searchFocusTick: s.searchFocusTick + 1 }));
      break;
    case 'exportPdf':
      useUI.setState({ exportOpen: true, menu: null });
      break;
    case 'toggleSidebar':
      useUI.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
      break;
  }
}
