import { studyQuestionPosedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";

// Daily study questions. question_uid is also the chat_uid of the question's
// solution-discussion chat.

export const questionsFold: Fold = {
  kind: "fold",
  name: "questions",
  version: 2,
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
    // The latest posing for a (topic, day) wins — deliberate re-poses (the
    // reactor's replace mode) supersede rather than stack.
    for (const event of events) {
      const q = studyQuestionPosedV1.parse(event.payload);
      await tx`delete from study_questions where topic = ${q.topic} and day = ${q.day}::date`;
      await tx`
        insert into study_questions (question_uid, day, topic, level, question, notes, posed_seq)
        values (${q.questionUid}, ${q.day}, ${q.topic}, ${q.level}, ${q.question},
                ${q.notes}, ${event.seq.toString()})`;
    }
  },
};
