import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { request } from 'librechat-data-provider';
import PromptTemplateExample from './PromptTemplateExample';

jest.mock('librechat-data-provider', () => ({ request: { getResponse: jest.fn() } }));
const getResponse = request.getResponse as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  URL.createObjectURL = jest.fn(() => 'blob:example');
  URL.revokeObjectURL = jest.fn();
});

test('legacy templates render nothing and make no image request', () => {
  const { container } = render(<PromptTemplateExample name="Legacy" />);
  expect(container).toBeEmptyDOMElement();
  expect(getResponse).not.toHaveBeenCalled();
});

test('loads through the authenticated request client and releases previews on removal', async () => {
  getResponse.mockResolvedValue({ data: new Blob(['image'], { type: 'image/png' }) });
  const { rerender } = render(<PromptTemplateExample name="Template" url="/example?v=1" />);
  expect(await screen.findByAltText('Template 图例')).toHaveAttribute('src', 'blob:example');
  expect(getResponse).toHaveBeenCalledWith('/example?v=1', { responseType: 'blob' });
  rerender(<PromptTemplateExample name="Template" />);
  expect(screen.queryByAltText('Template 图例')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:example');
});

test('defers the authenticated image request until a list example approaches the viewport', async () => {
  let notifyIntersection!: IntersectionObserverCallback;
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: jest.fn((callback: IntersectionObserverCallback) => {
      notifyIntersection = callback;
      return {
        observe: jest.fn(),
        disconnect: jest.fn(),
        unobserve: jest.fn(),
      };
    }),
  });
  getResponse.mockResolvedValue({ data: new Blob(['image'], { type: 'image/png' }) });

  render(
    <PromptTemplateExample
      name="Deferred template"
      url="/deferred-example?v=1"
      deferUntilVisible
    />,
  );

  expect(screen.getByText('图例等待加载')).toBeInTheDocument();
  expect(getResponse).not.toHaveBeenCalled();

  act(() => {
    notifyIntersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });

  expect(await screen.findByAltText('Deferred template 图例')).toBeInTheDocument();
  expect(getResponse).toHaveBeenCalledWith('/deferred-example?v=1', { responseType: 'blob' });
});

test('loads a replacement immediately after a deferred example has become visible', async () => {
  let notifyIntersection!: IntersectionObserverCallback;
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: jest.fn((callback: IntersectionObserverCallback) => {
      notifyIntersection = callback;
      return {
        observe: jest.fn(),
        disconnect: jest.fn(),
        unobserve: jest.fn(),
      };
    }),
  });
  getResponse.mockResolvedValue({ data: new Blob(['image'], { type: 'image/png' }) });
  (URL.createObjectURL as jest.Mock)
    .mockReturnValueOnce('blob:first')
    .mockReturnValueOnce('blob:replacement');

  const { rerender } = render(
    <PromptTemplateExample name="Template" url="/example?v=1" deferUntilVisible />,
  );
  act(() => {
    notifyIntersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
  expect(await screen.findByAltText('Template 图例')).toHaveAttribute('src', 'blob:first');

  rerender(<PromptTemplateExample name="Template" url="/example?v=2" deferUntilVisible />);

  await waitFor(() =>
    expect(screen.getByAltText('Template 图例')).toHaveAttribute('src', 'blob:replacement'),
  );
});

test('lets an operator retry a transient image request failure', async () => {
  getResponse
    .mockRejectedValueOnce(new Error('temporary network failure'))
    .mockResolvedValueOnce({ data: new Blob(['image'], { type: 'image/png' }) });

  render(<PromptTemplateExample name="Template" url="/example?v=1" />);

  fireEvent.click(await screen.findByRole('button', { name: '重试加载图例' }));

  expect(await screen.findByAltText('Template 图例')).toHaveAttribute('src', 'blob:example');
  expect(getResponse).toHaveBeenCalledTimes(2);
});

test('a failed or broken image has a safe fallback and a replacement can load', async () => {
  getResponse.mockRejectedValueOnce(new Error('missing file'));
  const { rerender } = render(<PromptTemplateExample name="Template" url="/example?v=1" />);
  expect(await screen.findByRole('button', { name: '重试加载图例' })).toBeInTheDocument();
  getResponse.mockResolvedValue({ data: new Blob(['image'], { type: 'image/png' }) });
  rerender(<PromptTemplateExample name="Template" url="/example?v=2" />);
  const image = await screen.findByAltText('Template 图例');
  fireEvent.error(image);
  expect(screen.getByRole('button', { name: '重试加载图例' })).toBeInTheDocument();
});

test('a slow previous image cannot replace the newly selected template image', async () => {
  let resolveOld!: (value: unknown) => void;
  getResponse.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const { rerender } = render(<PromptTemplateExample name="Old" url="/old" />);
  getResponse.mockResolvedValue({ data: new Blob(['new'], { type: 'image/png' }) });
  rerender(<PromptTemplateExample name="New" url="/new" />);
  await screen.findByAltText('New 图例');
  await act(async () => {
    resolveOld({ data: new Blob(['old']) });
  });
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  expect(screen.getByAltText('New 图例')).toHaveAttribute('src', 'blob:example');
});
