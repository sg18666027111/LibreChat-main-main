import { useLocation } from 'react-router-dom';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, getRouteOnlyPanelId } from '~/Providers';

/**
 * Renders the expanded sidebar content for the active nav link.
 * Route-only links (SKU / AI 生图 / admin pages) intentionally have no Component —
 * never fall back to the conversations list (that was an IA leak).
 */
export default function Nav({ links }: { links: NavLink[] }) {
  const { active } = useActivePanel();
  const location = useLocation();
  const routePanelId = getRouteOnlyPanelId(location.pathname);
  const effectiveActive = resolveActivePanel(routePanelId ?? active, links);
  const activeLink = links.find((link) => link.id === effectiveActive);

  if (activeLink?.Component == null) {
    return (
      <div
        className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden text-text-primary"
        data-testid="side-panel-empty"
        aria-hidden="true"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden text-text-primary">
      <activeLink.Component key={activeLink.id} />
    </div>
  );
}
