import debounce from 'lodash/debounce';
import { FileSources, EToolResources, removeNullishValues } from 'librechat-data-provider';
import { useCallback, useRef, useMemo, useEffect } from 'react';
import type * as t from 'librechat-data-provider';
import type { UseMutateAsyncFunction } from '@tanstack/react-query';
import type { ExtendedFile, GenericSetter } from '~/common';
import useSetFilesToDelete from './useSetFilesToDelete';
import { deletePreview } from '~/utils';

type FileMapSetter = GenericSetter<Map<string, ExtendedFile>>;
type PendingDelete = {
  file: t.BatchFile;
  remove: () => void;
  context: Pick<t.DeleteFilesBody, 'agent_id' | 'assistant_id' | 'tool_resource'>;
};

const useFileDeletion = ({
  mutateAsync,
  agent_id,
  assistant_id,
  tool_resource,
}: {
  mutateAsync: UseMutateAsyncFunction<t.DeleteFilesResponse, unknown, t.DeleteFilesBody, unknown>;
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: EToolResources;
}) => {
  const pending = useRef<PendingDelete[]>([]);
  const setFilesToDelete = useSetFilesToDelete();
  const mutation = useRef(mutateAsync);
  mutation.current = mutateAsync;
  const debouncedDelete = useMemo(
    () =>
      debounce(async () => {
        const batch = pending.current;
        pending.current = [];
        const groups = new Map<string, PendingDelete[]>();
        for (const entry of batch) {
          const key = JSON.stringify(entry.context);
          const group = groups.get(key) ?? [];
          group.push(entry);
          groups.set(key, group);
        }
        await Promise.all(
          [...groups.values()].map(async (group) => {
            try {
              const result = await mutation.current({
                files: group.map(({ file }) => file),
                ...group[0].context,
              });
              const deletedIds = new Set(result?.deletedFileIds ?? []);
              group.forEach(({ file, remove }) => {
                if (deletedIds.has(file.file_id)) {
                  remove();
                }
              });
            } catch {
              // The mutation reports the error. Keep files and previews for retry.
            }
          }),
        );
      }, 1000),
    [],
  );

  useEffect(() => () => debouncedDelete.cancel(), [debouncedDelete]);

  const deleteFile = useCallback(
    ({ file: original, setFiles }: { file: ExtendedFile | t.TFile; setFiles?: FileMapSetter }) => {
      if ((original['progress'] ?? 1) < 1) {
        return;
      }
      const {
        file_id,
        temp_file_id,
        filepath = '',
        source = FileSources.local,
        embedded,
      } = original;
      const remove = () => {
        if (setFiles) {
          setFiles((currentFiles) => {
            const updatedFiles = new Map(currentFiles);
            updatedFiles.delete(file_id);
            if (temp_file_id) {
              updatedFiles.delete(temp_file_id);
            }
            setFilesToDelete(Object.fromEntries(updatedFiles));
            return updatedFiles;
          });
        }
        deletePreview(file_id);
        if (temp_file_id) {
          deletePreview(temp_file_id);
        }
      };
      // Attached files are only being removed from the draft, not from storage.
      if ((original as t.TFile & { attached?: boolean }).attached) {
        remove();
        return;
      }
      pending.current.push({
        file: { file_id, temp_file_id, filepath, source, embedded: embedded ?? false },
        context: removeNullishValues({ agent_id, assistant_id, tool_resource }),
        remove,
      });
      debouncedDelete();
    },
    [debouncedDelete, setFilesToDelete, agent_id, assistant_id, tool_resource],
  );

  const deleteFiles = useCallback(
    ({ files, setFiles }: { files: ExtendedFile[] | t.TFile[]; setFiles?: FileMapSetter }) => {
      files.forEach((file) => deleteFile({ file, setFiles }));
    },
    [deleteFile],
  );

  return { deleteFile, deleteFiles };
};

export default useFileDeletion;
