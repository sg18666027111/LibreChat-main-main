import { useDeleteFilesMutation } from '~/data-provider';
import useFileDeletion from './useFileDeletion';

export default function useDeleteFilesFromTable(callback?: () => void) {
  const deletionMutation = useDeleteFilesMutation({
    onSuccess: () => callback?.(),
    onError: () => callback?.(),
  });

  return useFileDeletion({ mutateAsync: deletionMutation.mutateAsync });
}
