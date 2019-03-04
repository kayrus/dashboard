
//
// Copyright (c) 2018 by SAP SE or an SAP affiliate company. All rights reserved. This file is licensed under the Apache Software License, v. 2 except as noted otherwise in the LICENSE file
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

'use strict'
const Queue = require('better-queue')
const isIp = require('is-ip')
const _ = require('lodash')

const logger = require('../logger')
const config = require('../config')
const {
  getSeedKubeconfig,
  getShootIngressDomainForSeed,
  getSoilIngressDomainForSeed,
  createOwnerRefArrayForServiceAccount
} = require('../utils')
const kubernetes = require('../kubernetes')
const Resources = kubernetes.Resources
const {
  toClusterRoleResource,
  toClusterRoleBindingResource,
  toServiceAccountResource,
  toCronjobResource,
  toIngressResource,
  toEndpointResource,
  toServiceResource
} = require('./terminalResources')
const shoots = require('../services/shoots')

const TERMINAL_CLEANUP = 'dashboard-terminal-cleanup'
const TERMINAL_KUBE_APISERVER = 'dashboard-terminal-kube-apiserver'

const GARDEN_NAMESPACE = 'garden'
const CLUSTER_ROLE_NAME_CLEANUP = 'garden.sapcloud.io:dashboard-terminal-cleanup'
const CLUSTER_ROLE_BINDING_NAME_CLEANUP = CLUSTER_ROLE_NAME_CLEANUP
const SERVICEACCOUNT_NAME_CLEANUP = TERMINAL_CLEANUP
const CRONJOB_NAME_CLEANUP = TERMINAL_CLEANUP

async function replaceClusterroleAttach ({ rbacClient, ownerReferences }) {
  const name = 'garden.sapcloud.io:dashboard-terminal-attach'
  const rules = [
    {
      apiGroups: [
        ''
      ],
      resources: [
        'pods/attach'
      ],
      verbs: [
        'get'
      ]
    }
  ]

  const body = toClusterRoleResource({ name, rules, ownerReferences })
  const client = rbacClient.clusterrole

  return replaceResource({ client, name, body })
}

async function replaceClusterroleCleanup ({ rbacClient, ownerReferences }) {
  const name = CLUSTER_ROLE_NAME_CLEANUP
  const rules = [
    {
      apiGroups: [
        ''
      ],
      resources: [
        'serviceaccounts'
      ],
      verbs: [
        'list',
        'delete'
      ]
    }
  ]

  const body = toClusterRoleResource({ name, rules, ownerReferences })
  const client = rbacClient.clusterrole

  return replaceResource({ client, name, body })
}

async function replaceClusterroleBindingCleanup ({ rbacClient, saName, saNamespace, ownerReferences }) {
  const name = CLUSTER_ROLE_BINDING_NAME_CLEANUP
  const clusterRoleName = CLUSTER_ROLE_NAME_CLEANUP

  const roleRef = {
    apiGroup: Resources.ClusterRole.apiGroup,
    kind: Resources.ClusterRole.kind,
    name: clusterRoleName
  }

  const subjects = [
    {
      kind: Resources.ServiceAccount.kind,
      name: saName,
      namespace: saNamespace
    }
  ]

  const body = toClusterRoleBindingResource({ name, roleRef, subjects, ownerReferences })
  const client = rbacClient.clusterrolebinding

  return replaceResource({ client, name, body })
}

async function replaceServiceAccountCleanup ({ coreClient }) {
  const name = SERVICEACCOUNT_NAME_CLEANUP
  const namespace = GARDEN_NAMESPACE

  const body = toServiceAccountResource({ name })
  const client = coreClient.ns(namespace).serviceaccounts

  return replaceResource({ client, name, body })
}

async function replaceCronJobCleanup ({ batchClient, saName, ownerReferences }) {
  const name = CRONJOB_NAME_CLEANUP
  const namespace = GARDEN_NAMESPACE
  const image = _.get(config, 'terminal.cleanup.image')
  const noHeartbeatDeleteSeconds = String(_.get(config, 'terminal.cleanup.noHeartbeatDeleteSeconds', 300))
  const schedule = _.get(config, 'terminal.cleanup.schedule', '*/5 * * * *')

  const securityContext = {
    runAsUser: 1000,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true
  }
  const spec = {
    concurrencyPolicy: 'Forbid',
    schedule,
    jobTemplate: {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: TERMINAL_CLEANUP,
                image,
                imagePullPolicy: 'IfNotPresent',
                env: [
                  {
                    name: 'NO_HEARTBEAT_DELETE_SECONDS',
                    value: noHeartbeatDeleteSeconds
                  }
                ]
                // TODO limit resources
              }
            ],
            securityContext,
            restartPolicy: 'OnFailure',
            serviceAccountName: saName
          }
        }
      }
    }
  }

  const body = toCronjobResource({ name, spec, ownerReferences })
  const client = batchClient.ns(namespace).cronjob

  return replaceResource({ client, name, body })
}

async function replaceIngressApiServer ({ name = TERMINAL_KUBE_APISERVER, extensionClient, namespace, host, serviceName, ownerReferences }) {
  const annotations = _.get(config, 'terminal.bootstrap.apiserverIngress.annotations')

  const spec = {
    rules: [
      {
        host,
        http: {
          paths: [
            {
              backend: {
                serviceName,
                servicePort: 443
              },
              path: '/'
            }
          ]
        }
      }
    ],
    tls: [
      {
        hosts: [
          host
        ],
        secretName: `${name}-tls`
      }
    ]
  }

  const body = toIngressResource({ name, annotations, spec, ownerReferences })
  const client = extensionClient.ns(namespace).ingress

  return replaceResource({ client, name, body })
}

async function replaceEndpointKubeApiserver ({ name = TERMINAL_KUBE_APISERVER, coreClient, namespace, ip, ownerReferences }) {
  // TODO label role: apiserver ?
  const subsets = [
    {
      addresses: [
        {
          ip
        }
      ],
      ports: [
        {
          port: 443,
          protocol: 'TCP'
        }
      ]
    }
  ]

  const body = toEndpointResource({ name, namespace, subsets, ownerReferences })
  const client = coreClient.ns(namespace).endpoints

  return replaceResource({ client, name, body })
}

async function replaceServiceKubeApiserver ({ name = TERMINAL_KUBE_APISERVER, coreClient, namespace, externalName = undefined, ownerReferences }) {
  let type
  if (externalName) {
    type = 'ExternalName'
  }

  // TODO label role: apiserver ?
  const spec = {
    ports: [
      {
        port: 443,
        protocol: 'TCP',
        targetPort: 443
      }
    ],
    type, // optional
    externalName // optional
  }

  const body = toServiceResource({ name, namespace, spec, ownerReferences })
  const client = coreClient.ns(namespace).services

  return replaceResource({ client, name, body })
}

async function replaceResource ({ client, name, body }) {
  try {
    await client.get({ name })
    return client.mergePatch({ name, body })
  } catch (err) {
    if (err.code === 404) {
      return client.post({ body })
    }
    throw err
  }
}

async function handleSeed (seed, cb) {
  const name = seed.metadata.name
  logger.debug(`creating / updating resources on seed ${name} for webterminals`)
  const coreClient = kubernetes.core()
  const gardenClient = kubernetes.garden()
  const seedKubeconfig = await getSeedKubeconfig({ coreClient, seed, waitUntilAvailable: true })
  if (!seedKubeconfig) { // TODO retry later?
    throw new Error(`could not get kubeconfig for seed ${name}`)
  }
  const fromSeedKubeconfig = kubernetes.fromKubeconfig(seedKubeconfig)
  const seedCoreClient = kubernetes.core(fromSeedKubeconfig)
  const seedRbacClient = kubernetes.rbac(fromSeedKubeconfig)
  const seedBatchClient = kubernetes.batch(fromSeedKubeconfig)

  const ownerReferences = await bootstrapCleanupResourcesAndGetOwnerRefs({ coreClient: seedCoreClient, rbacClient: seedRbacClient, batchClient: seedBatchClient })
  await bootstrapAttachResources({ rbacClient: seedRbacClient, ownerReferences })

  // now make sure we expose the kube-apiserver with a browser-trusted certificate
  const isSoil = _.get(seed, ['metadata', 'labels', 'garden.sapcloud.io/role']) === 'soil'
  if (isSoil) {
    const soilSeedResource = seed
    await bootstrapIngressAndHeadlessServiceForSoilOnSoil({ coreClient, soilSeedResource })
  } else {
    await bootstrapIngressForSeedOnSoil({ gardenClient, coreClient, seedName: name })
  }
}

async function bootstrapCleanupResourcesAndGetOwnerRefs ({ coreClient, rbacClient, batchClient }) {
  const serviceAccountResource = await replaceServiceAccountCleanup({ coreClient })
  const { metadata: { name: saName, namespace: saNamespace } } = serviceAccountResource
  const ownerReferences = createOwnerRefArrayForServiceAccount(serviceAccountResource)
  await replaceClusterroleCleanup({ rbacClient, ownerReferences })
  await replaceClusterroleBindingCleanup({ rbacClient, saName, saNamespace, ownerReferences })
  await replaceCronJobCleanup({ batchClient, saName, ownerReferences })

  return ownerReferences
}

async function bootstrapAttachResources ({ rbacClient, ownerReferences }) {
  return replaceClusterroleAttach({ rbacClient, ownerReferences })
}

async function bootstrapIngressForSeedOnSoil ({ gardenClient, coreClient, seedName }) {
  const seedShootResource = await shoots.read({ gardenClient, namespace: 'garden', name: seedName })

  // fetch soil's seed resource
  const soilName = seedShootResource.spec.cloud.seed
  const soilSeedResource = await gardenClient.seeds.get({ name: soilName })

  // get soil client
  const soilKubeconfig = await getSeedKubeconfig({ coreClient, seed: soilSeedResource })
  const soilClientConfig = kubernetes.fromKubeconfig(soilKubeconfig)
  const soilExtensionClient = kubernetes.extensions(soilClientConfig)

  // calculate ingress domain
  const soilIngressDomain = await getShootIngressDomainForSeed(seedShootResource, soilSeedResource)
  const apiserverIngressHost = `api.${soilIngressDomain}`

  // replace ingress apiserver resource
  const seedShootNS = _.get(seedShootResource, 'status.technicalID')
  if (!seedShootNS) {
    throw new Error(`could not get namespace for seed ${seedName} on soil`)
  }

  const serviceName = 'kube-apiserver'
  await replaceIngressApiServer({
    extensionClient: soilExtensionClient,
    namespace: seedShootNS,
    serviceName,
    host: apiserverIngressHost
  }) // TODO owner reference ?
}

async function bootstrapIngressAndHeadlessServiceForSoilOnSoil ({ coreClient, soilSeedResource }) {
  const soilKubeconfig = await getSeedKubeconfig({ coreClient, seed: soilSeedResource })
  const soilClientConfig = kubernetes.fromKubeconfig(soilKubeconfig)
  const soilCoreClient = kubernetes.core(soilClientConfig)
  const soilExtensionClient = kubernetes.extensions(soilClientConfig)

  const namespace = 'garden'
  const soilApiserverHostname = new URL(soilClientConfig.url).hostname
  const soilIngressDomain = await getSoilIngressDomainForSeed(soilSeedResource)
  const clusterNameForLog = soilSeedResource.metadata.name
  await bootstrapIngressAndHeadlessService({
    coreClient: soilCoreClient,
    extensionClient: soilExtensionClient,
    namespace,
    apiserverHostname: soilApiserverHostname,
    ingressDomain: soilIngressDomain,
    clusterNameForLog
  })
}

async function bootstrapIngressAndHeadlessService ({ name, coreClient, extensionClient, namespace, apiserverHostname, ingressDomain, clusterNameForLog }) {
  let service
  // replace headless service
  if (isIp(apiserverHostname)) {
    const ip = apiserverHostname
    await replaceEndpointKubeApiserver({ coreClient, namespace, ip })

    service = await replaceServiceKubeApiserver({ name, coreClient, namespace })
  } else {
    const externalName = apiserverHostname
    service = await replaceServiceKubeApiserver({ name, coreClient, namespace, externalName })
  }
  const serviceName = service.metadata.name

  const apiserverIngressHost = `api.${ingressDomain}`

  await replaceIngressApiServer({
    extensionClient,
    name,
    namespace,
    serviceName,
    host: apiserverIngressHost
  }) // TODO owner reference ?
}

function isTerminalBootstrapDisabled () {
  return _.get(config, 'terminal.bootstrap.disabled', true) // TODO enable by default
}

function verifyRequiredConfigExists () {
  if (isTerminalBootstrapDisabled()) {
    logger.debug('terminal bootstrap disabled by config')
    return false // no further checks needed, bootstrapping is disabled
  }
  let requiredConfigExists = true

  if (_.isEmpty(_.get(config, 'terminal.bootstrap.apiserverIngress.annotations'))) {
    logger.error('no terminal.bootstrap.apiserverIngress.annotations config found')
    requiredConfigExists = false
  }

  if (_.isEmpty(_.get(config, 'terminal.cleanup.image'))) {
    logger.error('no terminal.cleanup.image config found')
    requiredConfigExists = false
  }

  return requiredConfigExists
}

function bootstrapSeed ({ seed }) {
  if (isTerminalBootstrapDisabled()) {
    return
  }
  if (!requiredConfigExists) {
    return
  }
  const isBootstrapDisabledForSeed = _.get(seed, ['metadata', 'annotations', 'dashboard.garden.sapcloud.io/terminal-bootstrap-resources-disabled'], false)
  if (isBootstrapDisabledForSeed) {
    const name = _.get(seed, 'metadata.name')
    logger.debug(`terminal bootstrap disabled for seed ${name}`)
    return
  }

  bootstrapQueue.push(seed)
}

async function bootstrapGardener () {
  console.log('bootstrapping garden cluster')

  const coreClient = kubernetes.core()
  const rbacClient = kubernetes.rbac()
  const batchClient = kubernetes.batch()

  const ownerReferences = await bootstrapCleanupResourcesAndGetOwnerRefs({ coreClient, rbacClient, batchClient })
  await bootstrapAttachResources({ rbacClient, ownerReferences })
}

const requiredConfigExists = verifyRequiredConfigExists()

const options = {}
var bootstrapQueue = new Queue(async (seed, cb) => {
  try {
    await handleSeed(seed)
    cb(null, null)
  } catch (err) {
    logger.error(`failed to bootstrap terminal resources for seed ${seed.metadata.name}`, err)
    cb(err, null)
  }
}, options)

if (!isTerminalBootstrapDisabled() && requiredConfigExists) {
  bootstrapGardener()
    .catch(error => {
      logger.error('failed to bootstrap terminal resources for garden cluster', error)
    })
}

module.exports = {
  bootstrapSeed
}
