import {
    CodeWhispererStreaming,
    GenerateAssistantResponseCommandInput as GenerateAssistantResponseCommandInputCodeWhispererStreaming,
    GenerateAssistantResponseCommandOutput as GenerateAssistantResponseCommandOutputCodeWhispererStreaming,
    SendMessageCommandInput as SendMessageCommandInputCodeWhispererStreaming,
    SendMessageCommandOutput as SendMessageCommandOutputCodeWhispererStreaming,
    ExportResultArchiveCommandInput as ExportResultArchiveCommandInputCodeWhispererStreaming,
    ExportResultArchiveCommandOutput as ExportResultArchiveCommandOutputCodeWhispererStreaming,
} from '@amzn/codewhisperer-streaming'
import {
    QDeveloperStreaming,
    SendMessageCommandInput as SendMessageCommandInputQDeveloperStreaming,
    SendMessageCommandOutput as SendMessageCommandOutputQDeveloperStreaming,
} from '@amzn/amazon-q-developer-streaming-client'
import {
    CredentialsProvider,
    SDKInitializator,
    Logging,
    CredentialsType,
    BearerCredentials,
} from '@aws/language-server-runtimes/server-interface'
import { getBearerTokenFromProvider, isUsageLimitError } from './utils'
import { ConfiguredRetryStrategy } from '@aws-sdk/util-retry'
import { CredentialProviderChain, Credentials } from 'aws-sdk'
import { CLIENT_TIMEOUT_MS } from '../language-server/agenticChat/constants/constants'
import { AmazonQUsageLimitError } from './amazonQServiceManager/errors'
import { TokenIdentityProvider } from '@smithy/types'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types'

export type SendMessageCommandInput =
    | SendMessageCommandInputCodeWhispererStreaming
    | SendMessageCommandInputQDeveloperStreaming
export type SendMessageCommandOutput =
    | SendMessageCommandOutputCodeWhispererStreaming
    | SendMessageCommandOutputQDeveloperStreaming

type StreamingClient = CodeWhispererStreaming | QDeveloperStreaming
export type ChatCommandInput = SendMessageCommandInput | GenerateAssistantResponseCommandInputCodeWhispererStreaming
export type ChatCommandOutput = SendMessageCommandOutput | GenerateAssistantResponseCommandOutputCodeWhispererStreaming

export abstract class StreamingClientServiceBase {
    protected readonly region
    protected readonly endpoint

    inflightRequests: Set<AbortController> = new Set()

    abstract client: StreamingClient

    constructor(region: string, endpoint: string) {
        this.region = region
        this.endpoint = endpoint
    }

    abstract sendMessage(
        request: SendMessageCommandInput,
        abortController?: AbortController
    ): Promise<SendMessageCommandOutput>

    public abortInflightRequests() {
        this.inflightRequests.forEach(abortController => {
            abortController.abort()
        })
        this.inflightRequests.clear()
    }
}

export class StreamingClientService extends StreamingClientServiceBase {
    client: StreamingClient
    public profileArn?: string
    constructor(
        private credentialsProvider: CredentialsProvider,
        sdkInitializator: SDKInitializator,
        logging: Logging,
        region: string,
        endpoint: string,
        customUserAgent?: string
    ) {
        super(region, endpoint)

        logging.log(
            `Passing client for class CodeWhispererStreaming to sdkInitializator (v3) for additional setup (e.g. proxy)`
        )

        if (credentialsProvider.hasCredentials('iam')) {
            // Create a credential provider that fetches fresh credentials on each request
            const iamCredentialProvider: AwsCredentialIdentityProvider = async (): Promise<AwsCredentialIdentity> => {
                const creds = (await credentialsProvider.getCredentials('iam')) as Credentials
                logging.log(`Fetching new IAM credentials`)
                return {
                    accessKeyId: creds.accessKeyId,
                    secretAccessKey: creds.secretAccessKey,
                    sessionToken: creds.sessionToken,
                    expiration: creds.expireTime ? new Date(creds.expireTime) : new Date(), // Force refresh on each request if creds do not have expiration time
                }
            }

            this.client = sdkInitializator(QDeveloperStreaming, {
                region: region,
                endpoint: endpoint,
                // Do not pass credentials directly or you will get "object is not extensible" error when AWS SDK tries to modify frozen credentials
                credentials: iamCredentialProvider,
                retryStrategy: new ConfiguredRetryStrategy(0, (attempt: number) => 500 + attempt ** 10),
            })
        }
        // Use bearer token if credentials type is 'bearer' or undefined
        else {
            const tokenProvider = async () => {
                const token = getBearerTokenFromProvider(credentialsProvider)
                // without setting expiration, the tokenProvider will only be called once
                return { token, expiration: new Date() }
            }

            logging.log(
                `Passing client for class CodeWhispererStreaming to sdkInitializator (v3) for additional setup (e.g. proxy)`
            )
            this.client = sdkInitializator(CodeWhispererStreaming, {
                region,
                endpoint,
                token: tokenProvider,
                retryStrategy: new ConfiguredRetryStrategy(0, (attempt: number) => 500 + attempt ** 10),
                requestHandler: new NodeHttpHandler({
                    requestTimeout: CLIENT_TIMEOUT_MS,
                }),
                customUserAgent: customUserAgent,
            })
        }
    }

    getConfigToken(): TokenIdentityProvider | undefined {
        if (this.getCredentialsType() === 'bearer') {
            const client = this.client as CodeWhispererStreaming
            return client.config.token
        }
        return undefined // or throw an error if this should never happen
    }

    getCredentialsType(): CredentialsType {
        if (this.credentialsProvider.hasCredentials('iam')) {
            return 'iam'
        } else {
            return 'bearer'
        }
    }

    public async sendMessage(
        request: SendMessageCommandInput,
        abortController?: AbortController
    ): Promise<SendMessageCommandOutput> {
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        if (this.getCredentialsType() === 'bearer') {
            const client = this.client as CodeWhispererStreaming
            try {
                const response = await client.sendMessage(
                    { ...request, profileArn: this.profileArn },
                    {
                        abortSignal: controller.signal,
                    }
                )

                return response
            } catch (e) {
                if (isUsageLimitError(e)) {
                    throw new AmazonQUsageLimitError(e)
                }
                throw e
            } finally {
                this.inflightRequests.delete(controller)
            }
        } else if (this.getCredentialsType() === 'iam') {
            const client = this.client as QDeveloperStreaming
            const response = await client.sendMessage(request, {
                abortSignal: controller.signal,
            })

            this.inflightRequests.delete(controller)

            return response
        } else {
            throw new Error('invalid credentialsType in sendMessage')
        }
    }

    public async generateAssistantResponse(
        request: GenerateAssistantResponseCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<GenerateAssistantResponseCommandOutputCodeWhispererStreaming> {
        if (this.getCredentialsType() === 'iam') {
            throw new Error('generateAssistantResponse is not supported for iam credentials')
        }

        const tokenClient = this.client as CodeWhispererStreaming
        const controller: AbortController = abortController ?? new AbortController()

        this.inflightRequests.add(controller)

        try {
            const response = await tokenClient.generateAssistantResponse(
                { ...request, profileArn: this.profileArn },
                {
                    abortSignal: controller.signal,
                }
            )

            return response
        } catch (e) {
            // TODO add a test for this
            if (isUsageLimitError(e)) {
                throw new AmazonQUsageLimitError(e)
            }
            throw e
        } finally {
            this.inflightRequests.delete(controller)
        }
    }

    public async exportResultArchive(
        request: ExportResultArchiveCommandInputCodeWhispererStreaming,
        abortController?: AbortController
    ): Promise<ExportResultArchiveCommandOutputCodeWhispererStreaming> {
        if (this.getCredentialsType() === 'iam') {
            throw new Error('generateAssistantResponse is not supported for iam credentials')
        }

        const tokenClient = this.client as CodeWhispererStreaming
        const controller: AbortController = abortController ?? new AbortController()
        this.inflightRequests.add(controller)
        const response = await tokenClient.exportResultArchive(
            this.profileArn ? { ...request, profileArn: this.profileArn } : request
        )
        this.inflightRequests.delete(controller)
        return response
    }
}
