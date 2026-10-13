import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import LLMAssistant from './LLMAssistant';

jest.mock('librechat-data-provider', () => ({ request: { get: jest.fn(), post: jest.fn() } }));
const mockRequest = request as jest.Mocked<typeof request>;
const config = {
  defaultModelKey: 'deepseek_v4_pro',
  models: [
    {
      key: 'deepseek_v4_pro',
      name: 'DeepSeek V4 Pro',
      group: 'domestic',
      enabled: true,
      recommended: true,
      capabilities: ['text', 'reasoning'],
    },
    {
      key: 'glm_5_3',
      name: 'GLM 5.3',
      group: 'domestic',
      enabled: true,
      recommended: false,
      capabilities: ['text', 'reasoning', 'long-context'],
    },
  ],
};
function openPage(path = '/llm-assistant') {
  const navigationLabel = 'Navigate to GLM';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/llm-assistant/glm_5_3">{navigationLabel}</Link>
      <Routes>
        <Route path="/llm-assistant/:modelKey?" element={<LLMAssistant />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function send(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(mockRequest.post).toHaveBeenCalled());
}
beforeEach(() => {
  mockRequest.get.mockResolvedValue(config);
  mockRequest.post.mockResolvedValue({ text: 'test response' });
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

it('submits from the GLM route with its new model key', async () => {
  openPage('/llm-assistant/glm_5_3');
  await screen.findByRole('heading', { name: 'GLM 5.3' });
  await send('synthetic task');
  expect(mockRequest.post).toHaveBeenCalledWith('/api/llm-assistant/chat', {
    modelKey: 'glm_5_3',
    messages: [{ role: 'user', content: 'synthetic task' }],
  });
  await screen.findByText('test response');
});

it('explains the retired Kimi link before sending with GLM identity', async () => {
  openPage('/llm-assistant/kimi_k2_6');
  await screen.findByRole('heading', { name: 'GLM 5.3' });
  expect(screen.getByRole('status')).toHaveTextContent('Kimi K2.6');
  expect(screen.getByRole('status')).toHaveTextContent('GLM 5.3');
  expect(mockRequest.post).not.toHaveBeenCalled();
  await send('new conversation');
  expect(mockRequest.post).toHaveBeenCalledWith('/api/llm-assistant/chat', {
    modelKey: 'glm_5_3',
    messages: [{ role: 'user', content: 'new conversation' }],
  });
});

it('starts fresh when switching to GLM rather than relabeling prior assistant messages', async () => {
  openPage();
  await screen.findByRole('heading', { name: 'DeepSeek V4 Pro' });
  await send('old question');
  await screen.findByText('test response');
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));
  fireEvent.click(screen.getByRole('button', { name: /^GLM 5.3/ }));
  await screen.findByRole('heading', { name: 'GLM 5.3' });
  expect(screen.queryByText('old question')).not.toBeInTheDocument();
  expect(screen.queryByText('test response')).not.toBeInTheDocument();
  mockRequest.post.mockClear();
  await send('new question');
  expect(mockRequest.post).toHaveBeenCalledWith('/api/llm-assistant/chat', {
    modelKey: 'glm_5_3',
    messages: [{ role: 'user', content: 'new question' }],
  });
});

it('does not append an old model response after the user switches models', async () => {
  let resolveOld!: (value: { text: string }) => void;
  mockRequest.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  openPage();
  await screen.findByRole('heading', { name: 'DeepSeek V4 Pro' });
  await send('pending old question');
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek V4 Pro' }));
  fireEvent.click(screen.getByRole('button', { name: /^GLM 5.3/ }));
  await screen.findByRole('heading', { name: 'GLM 5.3' });
  await act(async () => resolveOld({ text: 'old model answer' }));
  expect(screen.queryByText('old model answer')).not.toBeInTheDocument();
  expect(screen.queryByText('pending old question')).not.toBeInTheDocument();
});

it('keeps a new conversation loading when an obsolete request fails', async () => {
  let rejectOld!: (reason: Error) => void;
  let resolveNew!: (value: { text: string }) => void;
  mockRequest.post.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  mockRequest.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveNew = resolve;
      }),
  );
  openPage();
  await screen.findByRole('heading', { name: 'DeepSeek V4 Pro' });
  await send('old pending question');
  fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
  await send('new pending question');
  await act(async () => rejectOld(new Error('obsolete request failure')));
  expect(screen.queryByText('obsolete request failure')).not.toBeInTheDocument();
  expect(screen.getByText('正在思考...')).toBeInTheDocument();
  expect(screen.queryByText('old pending question')).not.toBeInTheDocument();
  await act(async () => resolveNew({ text: 'new answer' }));
  expect(screen.getByText('new answer')).toBeInTheDocument();
  expect(mockRequest.post).toHaveBeenLastCalledWith('/api/llm-assistant/chat', {
    modelKey: 'deepseek_v4_pro',
    messages: [{ role: 'user', content: 'new pending question' }],
  });
});

it('ignores a pending response after navigating to the GLM route', async () => {
  let resolveOld!: (value: { text: string }) => void;
  mockRequest.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  openPage('/llm-assistant/deepseek_v4_pro');
  await screen.findByRole('heading', { name: 'DeepSeek V4 Pro' });
  await send('old route question');
  fireEvent.click(screen.getByRole('link', { name: 'Navigate to GLM' }));
  await screen.findByRole('heading', { name: 'GLM 5.3' });
  await act(async () => resolveOld({ text: 'old route answer' }));
  expect(screen.queryByText('old route question')).not.toBeInTheDocument();
  expect(screen.queryByText('old route answer')).not.toBeInTheDocument();
  expect(screen.queryByText('正在思考...')).not.toBeInTheDocument();
});
