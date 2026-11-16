import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { RequireSettingsOwner } from './RequireSettingsOwner';
import { renderWithRouter } from '../../test-utils';
import { story } from '../../test-story';

const authState = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => authState }));

const TABS = ['cameras', 'storage', 'mcp-clients'];

function renderAt(path: string) {
  return renderWithRouter(
    <Routes>
      <Route path="/settings/general" element={<div>GENERAL TAB</div>} />
      <Route element={<RequireSettingsOwner />}>
        {TABS.map(tab => <Route key={tab} path={`/settings/${tab}`} element={<div>{`OWNER TAB ${tab}`}</div>} />)}
      </Route>
    </Routes>,
    { route: path },
  );
}

describe('RequireSettingsOwner', () => {
  for (const tab of TABS) it(`WEB-001 / WEB-SETTINGS-012: an operator who types /settings/${tab} lands on General`, (ctx) => {
    story(ctx, 'Operator (admin) wpisujący adres zakładki ukrytej w menu (Kamery, Magazyn, Klienci MCP) jest przekierowany na /settings/general — zakładka się nie renderuje.');
    authState.isAdmin = true;
    renderAt(`/settings/${tab}`);
    expect(screen.getByText('GENERAL TAB')).toBeInTheDocument();
    expect(screen.queryByText(`OWNER TAB ${tab}`)).not.toBeInTheDocument();
  });

  for (const tab of TABS) it(`WEB-SETTINGS-012: an owner opens /settings/${tab} as before`, (ctx) => {
    story(ctx, 'Właściciel kamer (i konto self-hosted, które nie jest adminem) otwiera te zakładki bez przekierowania.');
    authState.isAdmin = false;
    renderAt(`/settings/${tab}`);
    expect(screen.getByText(`OWNER TAB ${tab}`)).toBeInTheDocument();
    expect(screen.queryByText('GENERAL TAB')).not.toBeInTheDocument();
  });
});
