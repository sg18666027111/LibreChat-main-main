import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import useSideNavLinks from './useSideNavLinks';

let mockRole = 'USER';

jest.mock('~/hooks', () => ({
  useAgentCapabilities: () => ({ skillsEnabled: false }),
  useMCPServerManager: () => ({ availableMCPServers: [] }),
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useHasAccess: () => false,
  useAuthContext: () => ({ user: { role: mockRole } }),
}));

jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/SidePanel/Files/Panel', () => () => null);
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));

describe('shared sidebar links', () => {
  it.each(['USER', 'ADMIN'])('offers AI 生图 and omits retired destinations for %s', (role) => {
    mockRole = role;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter
        initialEntries={['/c/new']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        {children}
      </MemoryRouter>
    );
    const { result } = renderHook(
      () => ({
        links: useSideNavLinks({
          keyProvided: true,
          interfaceConfig: {},
          endpointsConfig: {},
        }),
        location: useLocation(),
      }),
      { wrapper },
    );

    const ids = result.current.links.map((link) => link.id);
    expect(ids).toContain('image-generation');
    expect(ids).toContain('sku-generation');
    for (const retiredId of ['image-canvas', 'video-assistant', 'audio-assistant']) {
      expect(ids).not.toContain(retiredId);
    }
    const imageLink = result.current.links.find((link) => link.id === 'image-generation');
    const skuLink = result.current.links.find((link) => link.id === 'sku-generation');
    expect(imageLink?.icon).toBeTruthy();
    expect(skuLink?.icon).toBeTruthy();
    expect(skuLink?.icon).not.toBe(imageLink?.icon);
    expect(imageLink?.routeOnly).toBe(true);
    expect(skuLink?.routeOnly).toBe(true);
    expect(imageLink?.Component).toBeUndefined();
    expect(skuLink?.Component).toBeUndefined();
    act(() => imageLink?.onClick?.());
    expect(result.current.location.pathname).toBe('/image-generation');
    act(() => skuLink?.onClick?.());
    expect(result.current.location.pathname).toBe('/sku-generation');
  });
});
