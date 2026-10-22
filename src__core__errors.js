// Erro de aplicação com código estável e mensagem em português para o usuário.
export class AppError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}
