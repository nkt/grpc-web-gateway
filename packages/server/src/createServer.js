// @flow strict
// Copyright 2018 dialog LLC <info@dlg.im>

import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import nanoid from 'nanoid';
import { Server as WebSocketServer } from 'ws';
import grpc, { Client as GrpcClient } from 'grpc';
import { identity, noop } from 'lodash/fp';
import {
  Request,
  Response,
  type GrpcStatusCode,
} from '@dlghq/grpc-web-gateway-signaling';

// $FlowFixMe
import pkg from '../package.json';
import { logger } from './logger';
import { createCredentials, type CredentialsConfig } from './credentials';
import { parseProtoFiles } from './utils/proto';
import { createMetadata, normalizeGrpcMetadata } from './grpcMetadata';
import { GrpcError } from './GrpcError';
import { setupPingConnections } from './heartbeat';

const invariant = (condition, message) => {
  if (!condition) {
    throw GrpcError.fromStatusName('UNKNOWN', message);
  }
};

type GrpcGatewayServerConfig = {
  api: string,
  server: HttpServer | HttpsServer,
  protoFiles: Array<string>,
  credentials?: CredentialsConfig,
  heartbeatInterval?: number,
};

const SECONDS = 1000;
const DEFAULT_HEARTBEAT_INTERVAL = 30 * SECONDS;

type GrpcStatus = {
  code: GrpcStatusCode,
  details: string,
  metadata?: { [string]: mixed },
};

export function createServer(config: GrpcGatewayServerConfig) {
  logger.info('Starting gateway version: ', pkg.version);

  const { heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL } = config;
  const services = parseProtoFiles(config.protoFiles);
  console.log({ services });
  const wss = new WebSocketServer({
    server: config.server,
  });

  const heartbeat = setupPingConnections(wss, heartbeatInterval);

  const getMethodDefinition = (service, method) => {
    const serviceDefinition = services.get(service);
    if (!serviceDefinition) {
      logger.error(
        'No such service ',
        service,
        ' in ',
        Array.from(services.keys()),
      );
      console.log(services);

      throw GrpcError.fromStatusName(
        'NOT_FOUND',
        `There is no service '${service}'`,
      );
    }

    const methodDefinition = serviceDefinition[method];
    if (!methodDefinition) {
      logger.error(
        'No such method ',
        `${service}/${method}`,
        ' in ',
        Array.from(services.keys()),
      );
      console.log(services);

      throw GrpcError.fromStatusName(
        'NOT_FOUND',
        `There is no such method '${method}' in service '${service}'`,
      );
    }

    return methodDefinition;
  };

  grpc.setLogger(logger);

  wss.on('error', (err: Error) => {
    logger.error('Connection error:', err);
  });

  wss.on('connection', ws => {
    const connectionId = nanoid();

    heartbeat.addConnection(connectionId, ws);

    const calls = new Map();
    const grpcClient = new GrpcClient(
      config.api,
      createCredentials(config.credentials),
      {},
    );

    const connectionLogger = logger.child({ connectionId });
    const wsSend = (data, cb) =>
      ws.readyState === ws.OPEN ? ws.send(data, cb) : noop;

    const handleGrpcClientError = (requestId, error: GrpcStatus) => {
      connectionLogger.error(requestId, error);
      connectionLogger.info('Sending error', error);

      wsSend(
        Response.encode({
          id: requestId,
          error: {
            status: error.code,
            message: error.details,
            metadata: error.metadata
              ? normalizeGrpcMetadata(error.metadata)
              : undefined,
          },
        }).finish(),
      );
    };

    const handleGrpcError = (requestId, error) => {
      connectionLogger.error(error);
      wsSend(Response.encode({ id: requestId, error }).finish());
    };

    const handleServerStream = (id, call) => {
      call.on('data', (response: Uint8Array) => {
        connectionLogger.info('Push Data');
        wsSend(
          Response.encode({
            id,
            push: { payload: response },
          }).finish(),
        );
      });

      call.on('end', () => {
        connectionLogger.info('Stream was ended');
        wsSend(
          Response.encode({
            id,
            end: {},
          }).finish(),
        );
        calls.delete(id);
      });

      call.on('close', () => {
        connectionLogger.info('Closing stream');
        wsSend(
          Response.encode({
            id,
            end: {},
          }).finish(),
        );
        calls.delete(id);
      });

      call.on('error', (error: GrpcStatus) => {
        handleGrpcClientError(id, error);
      });
    };

    const processUnaryRequest = (id, unaryPayload) => {
      try {
        const { service, method, payload, metadata } = unaryPayload;
        const methodDefinition = getMethodDefinition(service, method);

        if (methodDefinition.requestStream) {
          throw GrpcError.fromStatusName(
            'UNIMPLEMENTED',
            `There is no unary request method ${method} in service ${service}. Use stream request instead`,
          );
        }

        const path = methodDefinition.path;

        if (methodDefinition.responseStream) {
          connectionLogger.info('Server stream request', methodDefinition);
          const call = grpcClient.makeServerStreamRequest(
            path,
            identity,
            identity,
            payload,
            createMetadata(metadata || {}),
            {},
          );

          handleServerStream(id, call);
          calls.set(id, call);
        } else {
          connectionLogger.info('Unary request', methodDefinition);
          const call = grpcClient.makeUnaryRequest(
            path,
            identity,
            identity,
            payload,
            createMetadata(metadata || {}),
            {},
            (error: GrpcStatus, response: Uint8Array) => {
              if (error) {
                handleGrpcClientError(id, error);
              } else {
                connectionLogger.info('Unary Data');
                wsSend(
                  Response.encode({
                    id,
                    unary: { payload: response },
                  }).finish(),
                );
                calls.delete(id);
              }
            },
          );
          calls.set(id, call);
        }
      } catch (error) {
        handleGrpcError(id, error);
      }
    };

    const processStreamRequest = (id, streamPayload) => {
      try {
        const { service, method, metadata } = streamPayload;
        const methodDefinition = getMethodDefinition(service, method);

        if (!methodDefinition.requestStream) {
          throw GrpcError.fromStatusName(
            'UNIMPLEMENTED',
            `There is no stream request method ${method} in service ${service}. Use unary request instead`,
          );
        }

        const path = methodDefinition.path;

        if (methodDefinition.responseStream) {
          connectionLogger.info('Bidi stream request', methodDefinition);
          const call = grpcClient.makeBidiStreamRequest(
            path,
            identity,
            identity,
            createMetadata(metadata || {}),
            {},
          );
          calls.set(id, call);

          handleServerStream(id, call);
        } else {
          connectionLogger.info('Client stream request', methodDefinition);
          const call = grpcClient.makeClientStreamRequest(
            path,
            identity,
            identity,
            createMetadata(metadata || {}),
            {},
            (error: GrpcStatus, response: Uint8Array) => {
              if (error) {
                handleGrpcClientError(id, error);
              } else {
                connectionLogger.info('Client Stream Unary Response');
                wsSend(
                  Response.encode({
                    id,
                    unary: { payload: response },
                  }).finish(),
                );
              }
            },
          );
          calls.set(id, call);
          call.on('error', (error: GrpcStatus) => {
            handleGrpcClientError(id, error);
          });
        }
      } catch (error) {
        console.log({ error });
        handleGrpcError(id, error);
      }
    };

    ws.on('message', message => {
      try {
        invariant(
          message instanceof ArrayBuffer,
          'Message should be ArrayBuffer',
        );
        const request = Request.decode(new Uint8Array(message));
        const { id } = request;

        if (request.unary) {
          processUnaryRequest(id, request.unary);
        } else if (request.stream) {
          processStreamRequest(id, request.stream);
        } else if (request.push) {
          try {
            const { payload } = request.push;

            connectionLogger.info('Push request');

            const call = calls.get(id);
            if (!call) {
              throw GrpcError.fromStatusName(
                'NOT_FOUND',
                `There is no opened stream with id ${id}. Probably this is server problem`,
              );
            }

            call.write(payload);
          } catch (error) {
            handleGrpcError(id, error);
          }
        } else if (request.end) {
          connectionLogger.info('End request');
          try {
            const call = calls.get(id);
            if (!call) {
              throw GrpcError.fromStatusName(
                'NOT_FOUND',
                `There is no opened stream with id ${id}. Probably this is server problem`,
              );
            }

            call.end();
            calls.delete(id);
          } catch (error) {
            handleGrpcError(id, error);
          }
        } else if (request.cancel) {
          const { reason } = request.cancel;
          connectionLogger.info('Cancel request');
          try {
            const call = calls.get(id);
            if (!call) {
              throw GrpcError.fromStatusName(
                'NOT_FOUND',
                `There is no opened stream with id ${id}. Probably this is server problem`,
              );
            }

            connectionLogger.info('Cancelling call', id, { reason });

            call.cancel();
            calls.delete(id);
          } catch (error) {
            handleGrpcError(id, error);
          }
        } else if (request.service) {
          if (request.service.ping) {
            ws.send(
              Request.encode({
                id: 'service',
                service: {
                  pong: {},
                },
              }).finish(),
            );
          }
        }
      } catch (e) {
        connectionLogger.error('Not a Request', e);
      }
    });

    ws.on('close', () => {
      logger.info('Ws closed');
      Array.from(calls.values()).forEach(call => call.cancel());
      grpcClient.close();
    });
  });

  return wss;
}

export default createServer;
