/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';

jest.mock('~/components/Auth', () => ({
  Login: () => null,
  VerifyEmail: () => null,
  Registration: () => null,
  ResetPassword: () => null,
  ApiErrorWatcher: () => null,
  TwoFactorScreen: () => null,
  RequestPasswordReset: () => null,
}));

jest.mock('~/components/Agents/MarketplaceContext', () => ({
  MarketplaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('~/components/Agents/Marketplace', () => () => null);
jest.mock('~/components/OAuth', () => ({
  OAuthSuccess: () => null,
  OAuthError: () => null,
}));
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../RouteErrorBoundary', () => () => null);
jest.mock('../Layouts/Startup', () => () => null);
jest.mock('../Layouts/Login', () => () => null);
jest.mock('../Dashboard', () => ({
  __esModule: true,
  default: { path: 'dashboard', element: null },
}));
jest.mock('../ShareRoute', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../ChatRoute', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Search', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Root', () => ({
  __esModule: true,
  default: () => null,
}));

if (typeof Request === 'undefined') {
  global.Request = class Request {
    constructor(
      public url: string,
      public init?: RequestInit,
    ) {}
  } as any;
}

import { router } from '../index';

function flattenPaths(routes: RouteObject[]): string[] {
  return routes.flatMap((route) => [
    ...(route.path ? [route.path] : []),
    ...(route.children ? flattenPaths(route.children) : []),
  ]);
}

function findRoute(routes: RouteObject[], path: string): RouteObject | undefined {
  for (const route of routes) {
    if (route.path === path) {
      return route;
    }
    const child = findRoute(route.children ?? [], path);
    if (child) {
      return child;
    }
  }
  return undefined;
}

describe('retired feature routes', () => {
  it.each([
    ['/image-canvas', 'image-canvas'],
    ['/image-canvas/old-project', 'image-canvas/:projectId'],
    ['/video-assistant', 'video-assistant'],
    ['/audio-assistant', 'audio-assistant'],
  ])('replaces %s with the image generation route', async (url, path) => {
    const retiredRoute = findRoute((router as unknown as { routes: RouteObject[] }).routes, path);
    expect(retiredRoute).toBeDefined();
    const memoryRouter = createMemoryRouter(
      [
        { path: '/previous', element: <div>Previous page</div> },
        {
          path: '/',
          element: <Outlet />,
          children: [
            { path: 'image-generation', element: <div>Image generation page</div> },
            retiredRoute!,
          ],
        },
      ],
      {
        initialEntries: ['/previous', url],
        initialIndex: 1,
      },
    );
    const view = render(
      <RouterProvider router={memoryRouter} future={{ v7_startTransition: true }} />,
    );
    await waitFor(() => expect(memoryRouter.state.location.pathname).toBe('/image-generation'));
    expect(memoryRouter.state.historyAction).toBe('REPLACE');
    expect(view.getByText('Image generation page')).toBeInTheDocument();
    view.unmount();
  });
});

describe('skills routes', () => {
  it('registers the explicit /skills/new route', () => {
    const paths = flattenPaths((router as unknown as { routes: RouteObject[] }).routes);

    expect(paths).toContain('skills/new');
  });
});
