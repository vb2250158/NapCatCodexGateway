/** A domain validation rejection raised before business storage is changed. */
export class RoleStorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleStorageValidationError";
  }
}
