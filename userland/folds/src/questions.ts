import { studyQuestionPosedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";

// Daily study questions. question_uid is also the chat_uid of the question's
// solution-discussion chat.

export const questionsFold: Fold = {
  kind: "fold",
  name: "questions",
  version: 1,
  consumes: ["study.question.posed"],
  tables: ["study_questions"],
  async init(tx) {
    await tx`
      create table study_questions (
        question_uid uuid primary key,
        day          date not null,
        topic        text not null,
        level        int not null,
        question     text not null,
        notes        text not null,
        posed_seq    bigint not null
      )`;
    await tx`create index study_questions_day on study_questions (day)`;
    await tx`create index study_questions_topic on study_questions (topic, day)`;
  },
  async apply(tx, events) {
    // One question per (topic, day) by idempotency; per-event upserts are fine.
    for (const event of events) {
      const q = studyQuestionPosedV1.parse(event.payload);
      await tx`
        insert into study_questions (question_uid, day, topic, level, question, notes, posed_seq)
        values (${q.questionUid}, ${q.day}, ${q.topic}, ${q.level}, ${q.question},
                ${q.notes}, ${event.seq.toString()})
        on conflict (question_uid) do nothing`;
    }
  },
};
