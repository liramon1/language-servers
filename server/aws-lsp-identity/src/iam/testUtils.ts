import { CancellationToken } from '@aws/language-server-runtimes/server-interface'
import { stubInterface } from 'ts-sinon'
import { IamFlowParams } from './utils'
import { ProfileStore } from '../language-server/profiles/profileService'
import { StsCache } from '../sts/cache/stsCache'
import { StsAutoRefresher } from '../sts/stsAutoRefresher'
import { Observability } from '@aws/lsp-core'

/**
 * Creates a mock IamFlowParams object for testing
 * @param overrides - Optional properties to override default mock values
 * @returns A mock IamFlowParams object
 */
export function createMockIamFlowParams(overrides?: Partial<IamFlowParams>): IamFlowParams {
    // Create a logging stub that logs to console
    const loggingStub = {
        log: (message: string) => console.log(`[TEST LOG] ${message}`),
    }

    // Create the base mock
    const baseMock: IamFlowParams = {
        profile: {
            name: 'test-profile',
            kinds: [],
            settings: {},
        },
        callStsOnInvalidIamCredential: true,
        profileStore: stubInterface<ProfileStore>(),
        stsCache: stubInterface<StsCache>(),
        stsAutoRefresher: stubInterface<StsAutoRefresher>(),
        handlers: {
            sendGetMfaCode: async () => {
                console.log('[TEST] sendGetMfaCode called')
                return { code: 'test-mfa-code' }
            },
        },
        token: CancellationToken.None,
        observability: stubInterface<Observability>({
            logging: loggingStub,
        }),
    }

    // Apply any overrides
    return { ...baseMock, ...overrides }
}
