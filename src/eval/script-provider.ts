// The offline stand-in for a model.
//
// CI must be able to run every scenario with no model reachable, so each
// scenario ships a script: a function that decides what the model emits given
// the turn index and the conversation so far. What that proves and what it does
// NOT prove is worth being blunt about.
//
// It proves: the scenario's success state is reachable, the criteria actually
// fire on it, the tools do what the scenario assumes, and the loop wires tool
// results back correctly — including the refusal and error-recovery paths that
// are otherwise only reachable by getting a live model into an unusual state.
// It is a regression test for the harness and for the loop.
//
// It does not prove: that any real model would choose those calls. Only a live
// run does that, which is what `asterisk eval --live` is for. The same criteria
// grade both, so a scenario that passes scripted and fails live is telling you
// something about the model, not about the harness.

import type { Provider, ProviderRequest, ProviderResponse } from '../types/messages.ts';
import type { ScenarioScript } from './types.ts';

/** Large enough that compactHistory never fires. A script indexes by turn and
 *  may read earlier messages, so history rewriting underneath it would make the
 *  offline run depend on the compaction budget — an unrelated moving part. */
const SCRIPTED_CONTEXT_WINDOW = 4_000_000;

export function createScriptedProvider(script: ScenarioScript, workspace: string): Provider {
  let turn = 0;
  return {
    name: 'scripted',
    contextWindow: SCRIPTED_CONTEXT_WINDOW,
    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const current = turn++;
      const response = script({ turn: current, messages: request.messages, workspace });
      if (!response) {
        // Running off the end of a script means the loop went somewhere the
        // scenario author did not anticipate. Surfacing it as an error rather
        // than an empty end_turn keeps that from being graded as a pass.
        throw new Error(
          `scenario script exhausted at turn ${current} — the loop asked for a response the script does not define`,
        );
      }
      // Scripted responses skip streaming: request.onText exists only to drive
      // live UI, and replaying deltas here would add a moving part with nothing
      // downstream to observe it.
      return response;
    },
  };
}
