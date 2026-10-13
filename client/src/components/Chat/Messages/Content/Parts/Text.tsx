import { memo, useMemo, ReactElement } from 'react';
import { useRecoilValue } from 'recoil';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { useMessageContext } from '~/Providers';
import { cn, splitThinkingContent } from '~/utils';
import store from '~/store';
import Thinking from './Thinking';

type TextPartProps = {
  text: string;
  showCursor: boolean;
  isCreatedByUser: boolean;
  hideThinking?: boolean;
};

type ContentType =
  | ReactElement<React.ComponentProps<typeof Markdown>>
  | ReactElement<React.ComponentProps<typeof MarkdownLite>>
  | ReactElement;

const TextPart = memo(function TextPart({
  text,
  isCreatedByUser,
  showCursor,
  hideThinking = true,
}: TextPartProps) {
  const { isSubmitting = false, isLatestMessage = false } = useMessageContext();
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const showCursorState = useMemo(() => showCursor && isSubmitting, [showCursor, isSubmitting]);
  const { thinkingContent, regularContent } = useMemo(() => splitThinkingContent(text), [text]);
  const displayText = isCreatedByUser ? text : regularContent;
  const shouldShowThinking =
    !isCreatedByUser &&
    !hideThinking &&
    isLatestMessage &&
    isSubmitting &&
    thinkingContent.trim().length > 0 &&
    displayText.trim().length === 0;

  const content: ContentType = useMemo(() => {
    if (!isCreatedByUser) {
      return <Markdown content={displayText} isLatestMessage={isLatestMessage} />;
    } else if (enableUserMsgMarkdown) {
      return <MarkdownLite content={displayText} />;
    } else {
      return <>{displayText}</>;
    }
  }, [isCreatedByUser, enableUserMsgMarkdown, displayText, isLatestMessage]);

  return (
    <>
      {shouldShowThinking && <Thinking>{thinkingContent}</Thinking>}
      {displayText.length > 0 && (
        <div
          className={cn(
            isSubmitting ? 'submitting' : '',
            showCursorState && !!displayText.length ? 'result-streaming' : '',
            'markdown prose message-content dark:prose-invert light w-full break-words',
            isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
            isCreatedByUser ? 'dark:text-gray-20' : 'dark:text-gray-100',
          )}
        >
          {content}
        </div>
      )}
    </>
  );
});
TextPart.displayName = 'TextPart';

export default TextPart;
