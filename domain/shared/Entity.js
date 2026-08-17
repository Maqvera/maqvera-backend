// Enterprise DDD Internal Domain Model Standard (Improvement 16) — shared
// building block. An Entity has identity that persists across mutation;
// two entities are the same entity if their ids match, regardless of what
// their other fields currently hold.
export class Entity {
  constructor(id) {
    if (id === undefined || id === null || id === "") {
      throw new Error("Entity requires a non-empty identity.");
    }
    this._id = id;
  }

  get id() {
    return this._id;
  }

  equals(other) {
    if (!(other instanceof Entity)) return false;
    return String(other.id) === String(this._id);
  }
}
