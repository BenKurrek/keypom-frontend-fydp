import { AddIcon } from '@chakra-ui/icons';
import {
  Box,
  Button,
  Flex,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalOverlay,
  Switch,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import { useEffect, useState } from 'react';

import { FormControl } from '@/components/FormControl';
import { Checkbox } from '@/components/Checkbox/Checkbox';

export const EventQuestionsForm = () => {
  const { control, watch } = useFormContext();
  const { isOpen, onClose, onOpen } = useDisclosure();

  const {
    fields: questionsFields,
    append: appendQuestion,
    remove: removeQuestion,
  } = useFieldArray({
    control,
    name: 'questions',
  });

  console.log(watch());

  return (
    <>
      <FormControl
        helperText="Select which information you'd lke to capture from attendees, or alternatively create your own custom questions."
        label="Collect information (optional)"
      >
        <Box mt="4">
          <Flex justifyContent="space-between">
            <FormLabel>Question</FormLabel>
            <FormLabel mr="0">Is required?</FormLabel>
          </Flex>
          {questionsFields.map((question, index: number) => {
            const id = questionsFields?.[index]?.id;
            return (
              <Flex key={id} alignItems="center" justifyContent="space-between">
                <Controller
                  control={control}
                  name={`questions.${index}.isSelected`}
                  render={({ field, fieldState: { error } }) => {
                    return (
                      <Checkbox
                        isChecked={field.value}
                        p="0"
                        pl="0"
                        py="2"
                        value={field.value}
                        onChange={(e) => {
                          field.onChange(e.target.checked);
                        }}
                      >
                        <Text ml="2">{question.text}</Text>
                      </Checkbox>
                    );
                  }}
                />
                <Controller
                  control={control}
                  name={`questions.${index}.isRequired`}
                  render={({ field, fieldState: { error } }) => {
                    return <Switch isChecked={field.value} onChange={field.onChange} />;
                  }}
                />
              </Flex>
            );
          })}
        </Box>
      </FormControl>
      <Box textAlign="left">
        <Button
          iconSpacing="3"
          leftIcon={<AddIcon h="3" />}
          mt="2"
          variant="outline"
          onClick={onOpen}
        >
          Add question
        </Button>
      </Box>
      <AddQuestionModal
        isOpen={isOpen}
        onClose={onClose}
        onConfirm={(questionText) => {
          appendQuestion({
            text: questionText,
            type: 'TEXT',
            isRequired: true,
            selected: true,
          });
          onClose();
        }}
      />
    </>
  );
};

const AddQuestionModal = ({ isOpen, onClose, onConfirm }) => {
  const [question, setQuestion] = useState('');

  useEffect(() => {
    setQuestion('');
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalOverlay />
      <ModalContent>
        <ModalBody>
          <FormControl
            helperText="Add a question you'd like attendees to fill out for this event"
            label="Question"
          >
            <Input
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
              }}
            />
          </FormControl>
        </ModalBody>

        <ModalFooter>
          <Button
            w="full"
            onClick={() => {
              onConfirm(question);
            }}
          >
            Add question
          </Button>
          <Button variant="secondary" w="full" onClick={onClose}>
            Cancel
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
