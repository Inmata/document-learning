export const learningSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "document",
    "context",
    "rules",
    "observations",
    "retire",
    "skills"
  ],
  "properties": {
    "document": {
      "type": "boolean"
    },
    "context": {
      "type": "object"
    },
    "rules": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "value",
          "text",
          "category",
          "strength",
          "scope",
          "evidence"
        ],
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_.-]{1,120}$"
          },
          "value": {
            "type": "string",
            "minLength": 1
          },
          "text": {
            "type": "string",
            "minLength": 1,
            "maxLength": 6000
          },
          "category": {
            "type": "string",
            "enum": [
              "method",
              "preference",
              "fact",
              "constraint",
              "policy"
            ]
          },
          "strength": {
            "type": "string",
            "enum": [
              "suggestion",
              "default",
              "required"
            ]
          },
          "scope": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "task": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "kind": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "purpose": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "audience": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "customer": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "template": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "format": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "process": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "object": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "workspace": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "skill": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              }
            }
          },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "source",
                "quote"
              ],
              "properties": {
                "source": {
                  "type": "string",
                  "minLength": 1
                },
                "quote": {
                  "type": "string",
                  "minLength": 2
                }
              }
            }
          },
          "scopeBasis": {
            "type": "string",
            "enum": [
              "context",
              "explicit",
              "hypothesis"
            ]
          }
        }
      }
    },
    "observations": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "text",
          "evidence"
        ],
        "properties": {
          "text": {
            "type": "string",
            "minLength": 1
          },
          "scope": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "task": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "kind": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "purpose": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "audience": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "customer": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "template": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "format": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "process": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "object": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "workspace": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "skill": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              }
            }
          },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "source",
                "quote"
              ],
              "properties": {
                "source": {
                  "type": "string",
                  "minLength": 1
                },
                "quote": {
                  "type": "string",
                  "minLength": 2
                }
              }
            }
          }
        }
      }
    },
    "retire": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "scope",
          "evidence"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "scope": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "task": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "kind": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "purpose": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "audience": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "customer": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "template": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "format": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "process": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "object": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "workspace": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "skill": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              }
            }
          },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "source",
                "quote"
              ],
              "properties": {
                "source": {
                  "type": "string",
                  "minLength": 1
                },
                "quote": {
                  "type": "string",
                  "minLength": 2
                }
              }
            }
          }
        }
      }
    },
    "skills": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "title",
          "description",
          "body",
          "scope",
          "evidence",
          "positive",
          "negative",
          "ruleIds"
        ],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{0,62}$"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "body": {
            "type": "string",
            "minLength": 1
          },
          "scope": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "task": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "kind": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "purpose": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "audience": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "customer": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "template": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "format": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "process": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "object": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "workspace": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              },
              "skill": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                ]
              }
            }
          },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "source",
                "quote"
              ],
              "properties": {
                "source": {
                  "type": "string",
                  "minLength": 1
                },
                "quote": {
                  "type": "string",
                  "minLength": 2
                }
              }
            }
          },
          "positive": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "task": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "kind": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "purpose": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "audience": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "customer": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "template": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "format": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "process": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "object": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "workspace": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "skill": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                }
              }
            }
          },
          "negative": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "task": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "kind": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "purpose": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "audience": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "customer": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "template": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "format": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "process": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "object": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "workspace": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                },
                "skill": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    }
                  ]
                }
              }
            }
          },
          "ruleIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    }
  }
};

