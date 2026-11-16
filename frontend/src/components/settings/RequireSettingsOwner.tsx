import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

/**
 * Route gate for the Settings tabs that belong to a camera owner (Cameras,
 * Storage, MCP Clients). An operator (admin) never sees them in the nav, so a
 * typed URL goes to General instead of rendering a tab the server refuses
 * (WEB-SETTINGS-012). The self-hosted account is never an operator, so the gate
 * lets it through.
 */
export function RequireSettingsOwner() {
  const { isAdmin } = useAuth();
  if (isAdmin) return <Navigate to="/settings/general" replace />;
  return <Outlet />;
}
