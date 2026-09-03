import type { Todo, TodoSource } from "@friday/shared";

export interface Connector {
  source: TodoSource;
  fetchTodos(): Promise<Todo[]>;
}
