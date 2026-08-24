import { agentChatRepliedV1, userChatMessageSentV1 } from "@nc/schema";
import { jsonb } from "@nc/log";
import type { Fold } from "@nc/process";

// Operator-chat conversations, folded from chat events. chat_turns keeps
// both the display form (text + tool trace) and the raw API messages needed
// to resume a conversation with full tool-context fidelity.

export const chatsFold: Fold = {
  kind: "fold",
  name: "chats",
  version: 1,
  consumes: ["user.chat.message_sent", "agent.chat.replied"],
  tables: ["chats", "chat_turns"],
  async init(tx) {
    await tx`
      create table chats (
        chat_uid   uuid primary key,
        title      text not null,     -- first user message, truncated
        created_at timestamptz not null,
        last_at    timestamptz not null
      )`;
    await tx`create index chats_last on chats (last_at)`;
    await tx`
      create table chat_turns (
        event_seq    bigint primary key,
        chat_uid     uuid not null,
        role         text not null,   -- 'user' | 'assistant'
        text         text not null,
        trace        jsonb,
        api_messages jsonb
      )`;
    await tx`create index chat_turns_chat on chat_turns (chat_uid, event_seq)`;
  },
  async apply(tx, events) {
    // Chat volume is low; per-event upserts in seq order are fine.
    for (const event of events) {
      if (event.type === "user.chat.message_sent") {
        const m = userChatMessageSentV1.parse(event.payload);
        const at = event.occurredAt.toISOString();
        await tx`
          insert into chats (chat_uid, title, created_at, last_at)
          values (${m.chatUid}, ${m.text.slice(0, 80)}, ${at}, ${at})
          on conflict (chat_uid) do update set last_at = excluded.last_at`;
        await tx`
          insert into chat_turns (event_seq, chat_uid, role, text)
          values (${event.seq.toString()}, ${m.chatUid}, 'user', ${m.text})
          on conflict (event_seq) do nothing`;
        continue;
      }
      if (event.type === "agent.chat.replied") {
        const r = agentChatRepliedV1.parse(event.payload);
        await tx`
          update chats set last_at = ${event.occurredAt.toISOString()}
          where chat_uid = ${r.chatUid}`;
        await tx`
          insert into chat_turns (event_seq, chat_uid, role, text, trace, api_messages)
          values (${event.seq.toString()}, ${r.chatUid}, 'assistant', ${r.reply},
                  ${jsonb(tx, r.trace)}, ${jsonb(tx, r.apiMessages)})
          on conflict (event_seq) do nothing`;
        continue;
      }
      throw new Error(`chats fold received unexpected event type ${event.type}`);
    }
  },
};
