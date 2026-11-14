import { createTermsRegistry } from './state.mjs';
import { createTermsRequest, hideTermsCommands } from './host.mjs';
import { createUiPrimitives } from './common.mjs';
import { createTermEditor } from './editor.mjs';
import { createManager } from './manager.mjs';
import { createDock } from './dock.mjs';

const NAMESPACE = 'session-terms';

/** The only module that knows the host's registration and lifecycle contracts. */
export function createClientPlugin({ React, resources, styles }) {
  return {
    inject: [
      'slots',
      'locale',
      'uiConversation',
      'conversation',
      'sessions',
      'remote',
      'remote.commands',
    ],
    apply(ctx) {
      const registry = createTermsRegistry(createTermsRequest(ctx.remote.commands));
      const ui = createUiPrimitives(React, resources.errorCodes);
      function useTerms(sessionId) {
        const store = registry.forSession(sessionId);
        const state = React.useSyncExternalStore(
          store.subscribe,
          store.getSnapshot,
          store.getSnapshot,
        );
        return [state, store];
      }
      const TermEditor = createTermEditor({ React, useTerms, ui });
      const Manager = createManager({ React, useTerms, ui, TermEditor });
      const { StartedTermsDock, SelectionActions } = createDock({
        React,
        useTerms,
        ui,
        TermEditor,
        Manager,
        focusInput(sessionId) {
          const binding = ctx.sessions.binding(sessionId);
          if (!binding) return;
          try {
            ctx.conversation.input.for(binding.ctx).focus();
          } catch {
            /* Successful insertion must not become an error if focus is unavailable. */
          }
        },
      });

      ctx.effect(() => () => registry.dispose(), 'session-terms: state');
      ctx.effect(
        () => ctx.locale.register(NAMESPACE, resources.dictionaries),
        'session-terms: dictionaries',
      );
      ctx.effect(
        () => hideTermsCommands(ctx.uiConversation.events),
        'session-terms: command visibility',
      );
      ctx.effect(() => {
        const element = document.createElement('style');
        element.dataset.sessionTerms = '';
        element.textContent = styles;
        document.head.append(element);
        return () => element.remove();
      }, 'session-terms: styles');
      ctx.effect(() => {
        const refresh = () => {
          if (document.visibilityState === 'visible') registry.refreshActive();
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, 'session-terms: foreground refresh');
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: NAMESPACE,
            order: 30,
            locale: NAMESPACE,
          },
          StartedTermsDock,
        ),
      );
      // This keyed entry overrides the stock quote surface; disposing restores it.
      ctx.slots.inject('conversation.chat.text-interaction', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.text-interaction',
            key: 'quote',
            priority: -100,
            locale: NAMESPACE,
          },
          SelectionActions,
        ),
      );
    },
  };
}
