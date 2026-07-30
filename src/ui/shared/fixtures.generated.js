/* 自动生成，请勿手改。
   来源：src/contracts/fixtures/ · 生成器：scripts/build-preview-fixtures.js
   重新生成：npm run preview:fixtures */
window.FIXTURES = Object.freeze({
  "runtime": {
    "unavailable": {
      "schemaVersion": 1,
      "revision": 1,
      "sessionId": null,
      "phase": "unavailable",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": false,
        "canStop": false,
        "canRetry": false,
        "canRefine": false,
        "canTranslate": false,
        "availableProfiles": [],
        "availableSourceIds": [],
        "translationTargets": [],
        "limitations": [
          {
            "capability": "start",
            "code": "MODEL_NOT_READY",
            "message": "需要先安装语音识别模型",
            "nextAction": "open-model-manager"
          },
          {
            "capability": "refine",
            "code": "REFINEMENT_MODEL_NOT_READY",
            "message": "精修模型尚未安装",
            "nextAction": "open-model-manager"
          },
          {
            "capability": "translate",
            "code": "AI_PROVIDER_NOT_CONFIGURED",
            "message": "需要先配置翻译服务",
            "nextAction": "open-settings"
          }
        ]
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "unavailable",
          "level": 0
        }
      ],
      "model": {
        "state": "missing",
        "profile": null,
        "progress": null
      },
      "lastError": null
    },
    "idle": {
      "schemaVersion": 1,
      "revision": 2,
      "sessionId": null,
      "phase": "idle",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": true,
        "canPause": false,
        "canResume": false,
        "canStop": false,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": []
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "inactive",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "starting": {
      "schemaVersion": 1,
      "revision": 3,
      "sessionId": "session-01",
      "phase": "starting",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": false,
        "canStop": false,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": [
          {
            "capability": "start",
            "code": "COMMAND_BUSY",
            "message": "正在启动音频和识别服务",
            "nextAction": null
          }
        ]
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "starting",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "listening": {
      "schemaVersion": 1,
      "revision": 4,
      "sessionId": "session-01",
      "phase": "listening",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": true,
        "canResume": false,
        "canStop": true,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": []
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "active",
          "level": 0.18
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "paused": {
      "schemaVersion": 1,
      "revision": 5,
      "sessionId": "session-01",
      "phase": "paused",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": true,
        "canStop": true,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": []
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "paused",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "resumed": {
      "schemaVersion": 1,
      "revision": 6,
      "sessionId": "session-01",
      "phase": "listening",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": true,
        "canResume": false,
        "canStop": true,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": []
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "active",
          "level": 0.14
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "stopping": {
      "schemaVersion": 1,
      "revision": 7,
      "sessionId": "session-01",
      "phase": "stopping",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": false,
        "canStop": false,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": [
          {
            "capability": "stop",
            "code": "COMMAND_BUSY",
            "message": "正在停止采集并写入会话",
            "nextAction": null
          }
        ]
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "paused",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": null
    },
    "recovering": {
      "schemaVersion": 1,
      "revision": 8,
      "sessionId": "session-01",
      "phase": "recovering",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": false,
        "canStop": false,
        "canRetry": false,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": [
          {
            "capability": "retry",
            "code": "AUTO_RECOVERY_IN_PROGRESS",
            "message": "正在重新连接系统音频",
            "nextAction": null
          }
        ]
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "recovering",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": {
        "scope": "audio",
        "code": "LOOPBACK_TRACK_ENDED",
        "message": "系统音频已中断，正在尝试恢复",
        "recoverable": true,
        "nextAction": null
      }
    },
    "error": {
      "schemaVersion": 1,
      "revision": 9,
      "sessionId": "session-01",
      "phase": "error",
      "capabilities": {
        "schemaVersion": 1,
        "canStart": false,
        "canPause": false,
        "canResume": false,
        "canStop": true,
        "canRetry": true,
        "canRefine": true,
        "canTranslate": true,
        "availableProfiles": [
          "fast",
          "balanced"
        ],
        "availableSourceIds": [
          "loopback"
        ],
        "translationTargets": [
          "en",
          "zh-CN"
        ],
        "limitations": []
      },
      "sources": [
        {
          "id": "mic",
          "label": "麦克风",
          "state": "unavailable",
          "level": 0
        },
        {
          "id": "loopback",
          "label": "系统音频",
          "state": "error",
          "level": 0
        }
      ],
      "model": {
        "state": "ready",
        "profile": "balanced",
        "progress": 1
      },
      "lastError": {
        "scope": "audio",
        "code": "MEDIA_PERMISSION_DENIED",
        "message": "没有麦克风或系统音频权限",
        "recoverable": true,
        "nextAction": "request-permission"
      }
    }
  },
  "captions": {
    "partial": {
      "schemaVersion": 1,
      "sessionId": "session-01",
      "sourceId": "loopback",
      "segmentId": "segment-17",
      "sequence": 90,
      "revision": 1,
      "kind": "partial",
      "t0": 12.34,
      "t1": 14.61,
      "text": "我们下周 review 一下",
      "translation": null
    },
    "final": {
      "schemaVersion": 1,
      "sessionId": "session-01",
      "sourceId": "loopback",
      "segmentId": "segment-17",
      "sequence": 91,
      "revision": 2,
      "kind": "final",
      "t0": 12.34,
      "t1": 15.02,
      "text": "我们下周 review 一下 roadmap。",
      "translation": null
    },
    "refined": {
      "schemaVersion": 1,
      "sessionId": "session-01",
      "sourceId": "loopback",
      "segmentId": "segment-17",
      "sequence": 92,
      "revision": 3,
      "kind": "refined",
      "t0": 12.34,
      "t1": 15.02,
      "text": "我们下周一起 review 一下 roadmap。",
      "translation": null
    },
    "translated": {
      "schemaVersion": 1,
      "sessionId": "session-01",
      "sourceId": "loopback",
      "segmentId": "segment-17",
      "sequence": 93,
      "revision": 4,
      "kind": "translated",
      "t0": 12.34,
      "t1": 15.02,
      "text": "我们下周一起 review 一下 roadmap。",
      "translation": {
        "language": "en",
        "text": "Let's review the roadmap together next week.",
        "basedOnRevision": 3
      }
    }
  },
  "commands": {
    "startOk": {
      "schemaVersion": 1,
      "ok": true,
      "code": "OK",
      "message": null,
      "recoverable": null,
      "nextAction": null
    },
    "modelNotReady": {
      "schemaVersion": 1,
      "ok": false,
      "code": "MODEL_NOT_READY",
      "message": "需要先安装均衡模型",
      "recoverable": true,
      "nextAction": "open-model-manager"
    },
    "commandBusy": {
      "schemaVersion": 1,
      "ok": false,
      "code": "COMMAND_BUSY",
      "message": "运行时正在迁移状态，请稍后重试",
      "recoverable": true,
      "nextAction": "retry"
    },
    "translationUnavailable": {
      "schemaVersion": 1,
      "ok": false,
      "code": "AI_PROVIDER_NOT_CONFIGURED",
      "message": "需要先配置翻译服务",
      "recoverable": true,
      "nextAction": "open-settings"
    }
  },
  "capabilities": {
    "full": {
      "schemaVersion": 1,
      "canStart": true,
      "canPause": false,
      "canResume": false,
      "canStop": false,
      "canRetry": false,
      "canRefine": true,
      "canTranslate": true,
      "availableProfiles": [
        "fast",
        "balanced",
        "accurate"
      ],
      "availableSourceIds": [
        "mic",
        "loopback"
      ],
      "translationTargets": [
        "en",
        "zh-CN",
        "ja"
      ],
      "limitations": []
    },
    "fallbackProfile": {
      "schemaVersion": 1,
      "canStart": true,
      "canPause": false,
      "canResume": false,
      "canStop": false,
      "canRetry": false,
      "canRefine": false,
      "canTranslate": false,
      "availableProfiles": [
        "balanced"
      ],
      "availableSourceIds": [
        "mic",
        "loopback"
      ],
      "translationTargets": [],
      "limitations": [
        {
          "capability": "refine",
          "code": "REFINEMENT_MODEL_NOT_READY",
          "message": "当前安装未包含精修模型",
          "nextAction": "open-model-manager"
        },
        {
          "capability": "translate",
          "code": "AI_PROVIDER_NOT_CONFIGURED",
          "message": "需要先配置翻译服务",
          "nextAction": "open-settings"
        }
      ]
    },
    "unavailable": {
      "schemaVersion": 1,
      "canStart": false,
      "canPause": false,
      "canResume": false,
      "canStop": false,
      "canRetry": false,
      "canRefine": false,
      "canTranslate": false,
      "availableProfiles": [],
      "availableSourceIds": [],
      "translationTargets": [],
      "limitations": [
        {
          "capability": "start",
          "code": "MODEL_NOT_READY",
          "message": "需要先安装语音识别模型",
          "nextAction": "open-model-manager"
        }
      ]
    }
  }
})
