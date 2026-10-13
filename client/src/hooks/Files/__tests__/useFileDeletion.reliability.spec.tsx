import React, { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, FileSources, QueryKeys, LocalStorageKeys } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useDeleteFilesMutation } from '~/data-provider/Files/mutations';
import useDeleteFilesFromTable from '../useDeleteFilesFromTable';
import useFileDeletion from '../useFileDeletion';

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockShowToast }) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ deletePreview: jest.fn() }));
jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: jest.requireActual('~/data-provider/Files/mutations')
    .useDeleteFilesMutation,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { deleteFiles: jest.fn() },
}));

const files = [
  {
    file_id: 'success',
    filepath: '/a',
    source: FileSources.local,
    progress: 1,
    filename: 'first.png',
  },
  {
    file_id: 'failed',
    filepath: '/b',
    source: FileSources.local,
    progress: 1,
    filename: 'retry.png',
  },
] as ExtendedFile[];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  queryClient.setQueryData([QueryKeys.files], files);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const [currentFiles, setFiles] = useState(new Map(files.map((file) => [file.file_id, file])));
      return { ...useDeleteFilesFromTable(), currentFiles, setFiles };
    },
    { wrapper },
  );
  return { ...hook, queryClient };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

it('retains pending and failed files with metadata, removes only confirmed deletes, and permits retry', async () => {
  (dataService.deleteFiles as jest.Mock).mockResolvedValueOnce({
    message: 'Some files could not be deleted',
    deletedFileIds: ['success'],
    failedFileIds: ['failed'],
  });
  const { result, queryClient } = setup();
  act(() => result.current.deleteFiles({ files, setFiles: result.current.setFiles }));
  expect([...result.current.currentFiles.keys()]).toEqual(['success', 'failed']);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await waitFor(() => expect([...result.current.currentFiles.keys()]).toEqual(['failed']));
  expect(result.current.currentFiles.get('failed')?.filename).toBe('retry.png');
  expect(queryClient.getQueryData([QueryKeys.files])).toEqual([files[1]]);
  expect(mockShowToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'error', message: 'Some files could not be deleted' }),
  );
  (dataService.deleteFiles as jest.Mock).mockResolvedValueOnce({
    message: 'Files deleted successfully',
    deletedFileIds: ['failed'],
    failedFileIds: [],
  });
  act(() => result.current.deleteFile({ file: files[1], setFiles: result.current.setFiles }));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await waitFor(() => expect(result.current.currentFiles.size).toBe(0));
  expect(queryClient.getQueryData([QueryKeys.files])).toEqual([]);
  expect(mockShowToast).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }));
});

it('keeps all items and shows an error on total failure', async () => {
  (dataService.deleteFiles as jest.Mock).mockRejectedValueOnce({
    response: {
      status: 500,
      data: {
        message: 'Files could not be deleted',
        deletedFileIds: [],
        failedFileIds: ['success', 'failed'],
      },
    },
  });
  const { result, queryClient } = setup();
  act(() => result.current.deleteFiles({ files, setFiles: result.current.setFiles }));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect([...result.current.currentFiles.values()]).toEqual(files);
  expect(queryClient.getQueryData([QueryKeys.files])).toEqual(files);
  expect(mockShowToast).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
});

it('retains failed temporary cleanup entries for a later retry', async () => {
  localStorage.setItem(
    LocalStorageKeys.FILES_TO_DELETE,
    JSON.stringify(Object.fromEntries(files.map((file) => [file.file_id, file]))),
  );
  (dataService.deleteFiles as jest.Mock).mockResolvedValueOnce({
    message: 'Partial failure',
    deletedFileIds: ['success'],
    failedFileIds: ['failed'],
  });
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useDeleteFilesMutation(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ files: files as any });
  });
  expect(JSON.parse(localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE) ?? '{}')).toEqual({
    failed: files[1],
  });
});

it('retries after a lost response and removes server-acknowledged already deleted files', async () => {
  (dataService.deleteFiles as jest.Mock).mockRejectedValueOnce(new Error('response lost'));
  const { result, queryClient } = setup();
  act(() => result.current.deleteFiles({ files, setFiles: result.current.setFiles }));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect([...result.current.currentFiles.values()]).toEqual(files);
  (dataService.deleteFiles as jest.Mock).mockResolvedValueOnce({
    message: 'Files deleted successfully',
    deletedFileIds: ['success', 'failed'],
    failedFileIds: [],
  });
  act(() => result.current.deleteFiles({ files, setFiles: result.current.setFiles }));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(result.current.currentFiles.size).toBe(0);
  expect(queryClient.getQueryData([QueryKeys.files])).toEqual([]);
});

it('keeps the resource context captured when each deletion was queued across rerenders', async () => {
  const requests: unknown[] = [];
  const mutateAsync = async (body: any) => {
    requests.push(body);
    return {
      message: 'Deleted',
      deletedFileIds: body.files.map((file: any) => file.file_id),
      failedFileIds: [],
    };
  };
  const { result, rerender } = renderHook(
    ({ agent_id }) => useFileDeletion({ mutateAsync, agent_id }),
    { initialProps: { agent_id: 'agent-a' } },
  );
  act(() => result.current.deleteFile({ file: files[0] }));
  rerender({ agent_id: 'agent-b' });
  act(() => result.current.deleteFile({ file: files[1] }));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(requests).toEqual([
    expect.objectContaining({
      agent_id: 'agent-a',
      files: [expect.objectContaining({ file_id: 'success' })],
    }),
    expect.objectContaining({
      agent_id: 'agent-b',
      files: [expect.objectContaining({ file_id: 'failed' })],
    }),
  ]);
});
