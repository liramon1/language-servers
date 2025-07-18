import { IAMClient, SimulatePrincipalPolicyCommand, SimulatePrincipalPolicyCommandOutput } from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import {
    AwsErrorCodes,
    CancellationToken,
    GetMfaCodeParams,
    GetMfaCodeResult,
    IamCredentials,
    Profile,
} from '@aws/language-server-runtimes/server-interface'
import { AwsError, Observability } from '@aws/lsp-core'
import { StsCache } from '../sts/cache/stsCache'
import { StsAutoRefresher } from '../sts/stsAutoRefresher'
import { ProfileStore } from '../language-server/profiles/profileService'
import { FromProcessInit } from '@aws-sdk/credential-provider-process'
import { AwsCredentialIdentityProvider, Provider, RuntimeConfigAwsCredentialIdentityProvider } from '@aws-sdk/types'
import { InstanceMetadataCredentials, RemoteProviderInit } from '@smithy/credential-provider-imds'
import { FromEnvInit } from '@aws-sdk/credential-provider-env'

// Simulate permissions on the identity associated with the credentials
export async function simulatePermissions(
    credentials: IamCredentials,
    permissions: string[],
    region?: string
): Promise<SimulatePrincipalPolicyCommandOutput> {
    console.log('simulatePermissions called with:', { permissions, region })
    // Convert the credentials into an identity
    console.log('Creating STS client with region:', region || 'us-east-1')
    const stsClient = new STSClient({ region: region || 'us-east-1', credentials: credentials })
    console.log('Sending GetCallerIdentityCommand')
    const identity = await stsClient.send(new GetCallerIdentityCommand({}))
    console.log('GetCallerIdentity response:', identity)
    if (!identity.Arn) {
        console.log('Error: Caller identity ARN not found')
        throw new AwsError('Caller identity ARN not found.', AwsErrorCodes.E_INVALID_PROFILE)
    }

    // Simulate permissions on the identity
    console.log('Creating IAM client with region:', region || 'us-east-1')
    const iamClient = new IAMClient({ region: region || 'us-east-1', credentials: credentials })

    const policyArn = convertToIamArn(identity.Arn)
    console.log('Converting ARN:', identity.Arn, 'to:', policyArn)

    console.log('Sending SimulatePrincipalPolicyCommand with:', {
        PolicySourceArn: policyArn,
        ActionNames: permissions,
    })

    const result = await iamClient.send(
        new SimulatePrincipalPolicyCommand({
            PolicySourceArn: policyArn,
            ActionNames: permissions,
        })
    )

    console.log('SimulatePrincipalPolicy response:', result)
    return result
}

// Converts an assumed role ARN into an IAM role ARN
function convertToIamArn(arn: string) {
    console.log('convertToIamArn called with:', arn)
    if (arn.includes(':assumed-role/')) {
        console.log('ARN contains :assumed-role/, converting to IAM role ARN')
        const parts = arn.split(':')
        const roleName = parts[5].split('/')[1]
        const result = `arn:aws:iam::${parts[4]}:role/${roleName}`
        console.log('Converted ARN:', result)
        return result
    } else {
        console.log('ARN does not contain :assumed-role/, returning as is')
        return arn
    }
}

export function throwOnInvalidCredentialId(iamCredentialId?: string): asserts iamCredentialId is string {
    if (!iamCredentialId?.trim()) {
        throw new AwsError('IAM credential id is invalid.', AwsErrorCodes.E_INVALID_STS_CREDENTIAL)
    }
}

export type CredentialProviders = {
    fromProcess: (init?: FromProcessInit) => RuntimeConfigAwsCredentialIdentityProvider
    fromContainerMetadata: (init?: RemoteProviderInit) => AwsCredentialIdentityProvider
    fromInstanceMetadata: (init?: RemoteProviderInit) => Provider<InstanceMetadataCredentials>
    fromEnv: (init?: FromEnvInit) => AwsCredentialIdentityProvider
}

export type SendGetMfaCode = (params: GetMfaCodeParams) => Promise<GetMfaCodeResult>

export type IamHandlers = {
    sendGetMfaCode: SendGetMfaCode
}

export type IamFlowParams = {
    profile: Profile
    callStsOnInvalidIamCredential: boolean
    profileStore: ProfileStore
    stsCache: StsCache
    stsAutoRefresher: StsAutoRefresher
    handlers: IamHandlers
    providers: CredentialProviders
    token: CancellationToken
    observability: Observability
}
