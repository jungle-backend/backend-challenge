import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class InfrastructureExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (this.isTransientInfrastructureError(exception)) {
      response.status(503).json({ code: 'INFRASTRUCTURE_UNAVAILABLE' });
      return;
    }
    console.error(JSON.stringify({ event: 'unhandled_request_error', path: request.url }));
    response.status(500).json({ code: 'INTERNAL_ERROR' });
  }

  private isTransientInfrastructureError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false;
    const code = String(error.code);
    return code.startsWith('08')
      || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '53300', '40001', '40P01'].includes(code);
  }
}