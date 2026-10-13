/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { MessagesSquare, LayoutTemplate, NotebookPen } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/extend-expect';
import type { NavLink } from '~/common';
import { ActivePanelProvider, DEFAULT_PANEL } from '~/Providers/ActivePanelContext';
import Nav from './Nav';

function ConversationsStub() {
  return <div data-testid="conversations-panel">对话列表</div>;
}

function PromptsStub() {
  return <div data-testid="prompts-panel">prompts</div>;
}

const links: NavLink[] = [
  {
    title: 'com_ui_chat_history' as never,
    icon: MessagesSquare,
    id: DEFAULT_PANEL,
    Component: ConversationsStub,
  },
  {
    title: 'com_ui_prompts' as never,
    icon: NotebookPen,
    id: 'prompts',
    Component: PromptsStub,
  },
  {
    title: 'SKU 图制作' as never,
    icon: LayoutTemplate,
    id: 'sku-generation',
    routeOnly: true,
    onClick: () => undefined,
  },
];

function renderNav(initialPath: string, initialPanel = DEFAULT_PANEL) {
  localStorage.setItem('side:active-panel', initialPanel);
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ActivePanelProvider>
        <Nav links={links} />
      </ActivePanelProvider>
    </MemoryRouter>,
  );
}

describe('SidePanel Nav', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders conversations when that panel is active on chat routes', () => {
    renderNav('/c/new', DEFAULT_PANEL);
    expect(screen.getByTestId('conversations-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('side-panel-empty')).not.toBeInTheDocument();
  });

  it('does not fall back to conversations on /sku-generation even if saved panel is conversations', () => {
    renderNav('/sku-generation', DEFAULT_PANEL);
    expect(screen.queryByTestId('conversations-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('side-panel-empty')).toBeInTheDocument();
  });

  it('does not fall back to conversations when active panel is sku-generation', () => {
    renderNav('/c/new', 'sku-generation');
    expect(screen.queryByTestId('conversations-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('side-panel-empty')).toBeInTheDocument();
  });

  it('still renders Component panels such as prompts', () => {
    renderNav('/c/new', 'prompts');
    expect(screen.getByTestId('prompts-panel')).toBeInTheDocument();
  });
});
