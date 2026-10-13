import React, { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilState, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import useChatFunctions from './useChatFunctions';
import store from '~/store';

const mockToast = jest.fn();
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockToast }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { name: 'Test user' } }),
}));
jest.mock('~/hooks/Conversations/useGetSender', () => () => () => 'Assistant');
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: () => null }));
jest.mock('~/utils', () => ({ logger: { log: jest.fn(), dir: jest.fn() } }));

type AskOptions = Parameters<ReturnType<typeof useChatFunctions>['ask']>[1];

function setup({
  convoId = 'convo-1',
  image = true,
  submitting = false,
  reference = null,
}: {
  convoId?: string;
  image?: boolean;
  submitting?: boolean;
  reference?: { name: string; boundConvoId: string } | null;
} = {}) {
  const setSubmission = jest.fn();
  const setMessages = jest.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.pendingManualSkillsByConvoId(convoId), ['sample-skill']);
            set(store.referencedSkill, reference);
          }}
        >
          {children}
        </RecoilRoot>
      </QueryClientProvider>
    </MemoryRouter>
  );
  const hook = renderHook(
    ({ model }: { model: string }) => {
      const [files, setFiles] = useState<Map<string, ExtendedFile>>(
        () =>
          new Map(
            image
              ? [
                  [
                    'image-1',
                    {
                      file_id: 'image-1',
                      type: 'image/png',
                      filepath: '/test.png',
                    } as ExtendedFile,
                  ],
                ]
              : [],
          ),
      );
      const [pending, setPending] = useRecoilState(store.pendingManualSkillsByConvoId(convoId));
      const latestMessage = {
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        text: '',
      } as TMessage;
      const chat = useChatFunctions({
        conversation: {
          conversationId: convoId,
          endpoint: EModelEndpoint.openAI,
          model,
        } as TConversation,
        isSubmitting: submitting,
        latestMessage,
        getMessages: () => [],
        setMessages,
        setSubmission,
        files,
        setFiles,
      });
      const referenceState = useRecoilValue(store.referencedSkill);
      return { ...chat, pending, setPending, files, referenceState };
    },
    { wrapper, initialProps: { model: 'deepseek-chat' } },
  );
  return { ...hook, setSubmission, setMessages };
}

describe('manual Skill selection at chat submission', () => {
  it.each(['convo-1', String(Constants.NEW_CONVO)])(
    'preserves Skill and image after rejection, then sends once after model switch (%s)',
    (convoId) => {
      const { result, rerender, setSubmission } = setup({ convoId });
      act(() => result.current.ask({ text: 'Analyze image' }));
      expect(mockToast).toHaveBeenCalled();
      expect(setSubmission).not.toHaveBeenCalled();
      expect(result.current.pending).toEqual(['sample-skill']);
      expect(result.current.files.size).toBe(1);

      rerender({ model: 'gpt-4o' });
      act(() => result.current.ask({ text: 'Analyze image' }));
      expect(setSubmission).toHaveBeenCalledTimes(1);
      expect(setSubmission.mock.calls[0][0]).toMatchObject({
        manualSkills: ['sample-skill'],
        userMessage: { manualSkills: ['sample-skill'], files: [{ file_id: 'image-1' }] },
        initialResponse: { manualSkills: ['sample-skill'] },
      });
      expect(result.current.pending).toEqual([]);
      expect(result.current.files.size).toBe(0);
      act(() => result.current.ask({ text: 'Next turn' }));
      expect(setSubmission.mock.calls[1][0].manualSkills).toBeUndefined();
    },
  );

  it.each<AskOptions>([
    { overrideManualSkills: [] },
    { overrideManualSkills: ['original-skill'] },
    { isRegenerate: true },
    { isContinued: true },
    { isEdited: true },
  ])('does not consume draft Skills when replaying a turn: %j', (options) => {
    const { result, setSubmission } = setup({ image: false });
    act(() => result.current.ask({ text: 'Replay' }, options));
    expect(result.current.pending).toEqual(['sample-skill']);
    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect(setSubmission.mock.calls[0][0].manualSkills).toEqual(
      options?.overrideManualSkills?.length ? ['original-skill'] : undefined,
    );
  });

  it.each([
    { text: ' ', submitting: false },
    { text: 'Send', submitting: true },
  ])('does not consume selection for early rejection: %j', ({ text, submitting }) => {
    const { result, setSubmission } = setup({ image: false, submitting });
    act(() => result.current.ask({ text }));
    expect(result.current.pending).toEqual(['sample-skill']);
    expect(setSubmission).not.toHaveBeenCalled();
  });

  it.each(['convo-1', 'other-convo'])(
    'preserves persistent reference priority and conversation boundary (%s)',
    (boundConvoId) => {
      const reference = { name: 'persistent-skill', boundConvoId };
      const { result, rerender, setSubmission } = setup({ reference });
      act(() => result.current.ask({ text: 'Analyze' }));
      expect(result.current.pending).toEqual(['sample-skill']);
      expect(result.current.referenceState).toEqual(reference);
      rerender({ model: 'gpt-4o' });
      act(() => result.current.ask({ text: 'Analyze' }));
      expect(setSubmission.mock.calls[0][0].manualSkills).toEqual([
        boundConvoId === 'convo-1' ? 'persistent-skill' : 'sample-skill',
      ]);
      if (boundConvoId === 'convo-1') {
        expect(setSubmission.mock.calls[0][0].ephemeralAgent.skills).toBe(true);
      }
      expect(result.current.referenceState).toEqual(reference);
    },
  );

  it('consumes a fresh text-only selection and includes it in the sent message', () => {
    const { result, setSubmission } = setup({ image: false });
    act(() => result.current.ask({ text: 'Write copy' }));
    expect(setSubmission.mock.calls[0][0].userMessage.manualSkills).toEqual(['sample-skill']);
    expect(result.current.pending).toEqual([]);
  });
});
